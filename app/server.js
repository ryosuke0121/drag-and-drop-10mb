'use strict';

const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');

// Simple in-memory rate limiter (requests per IP per minute)
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 20; // max requests per window per IP
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  entry.count += 1;
  rateLimitMap.set(ip, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'リクエストが多すぎます。しばらく待ってから再試行してください。' });
  }
  next();
}

// Periodic cleanup of stale rate-limit entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

// UUID v4 format validation
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const app = express();
const PORT = process.env.PORT || 3000;

const TARGET_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_VIDEO_DURATION = 60; // seconds
const MAX_FILES = 10;
const MAX_INPUT_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB per file

const UPLOAD_DIR = '/tmp/dnd-uploads';
const OUTPUT_DIR = '/tmp/dnd-outputs';

[UPLOAD_DIR, OUTPUT_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

// ─── helpers ─────────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif',
  'heic', 'heif', 'avif',
]);
const VIDEO_EXTS = new Set([
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'mts',
]);

const getExt = (name) => path.extname(name).toLowerCase().replace('.', '');
const isImageFile = (name) => IMAGE_EXTS.has(getExt(name));
const isVideoFile = (name) => VIDEO_EXTS.has(getExt(name));
const fileSize = (p) => fs.statSync(p).size;

function getMetadata(filePath) {
  return new Promise((resolve, reject) =>
    ffmpeg.ffprobe(filePath, (err, data) => (err ? reject(err) : resolve(data)))
  );
}

// ─── image compression ───────────────────────────────────────────────────────

/**
 * Compress an image to JPEG iteratively until ≤ TARGET_SIZE.
 * Strategy: decrease JPEG quality (q:v 1-31) then scale down dimensions.
 */
async function compressImage(inputPath, sessionDir, originalName) {
  const baseName = path.parse(originalName).name;
  const outputPath = path.join(sessionDir, `${baseName}_compressed.jpg`);

  // q:v scale for ffmpeg JPEG: 1 = highest quality (largest), 31 = lowest quality (smallest).
  // We iterate from high quality down to find the smallest file ≤ TARGET_SIZE.
  const attempts = [
    { qv: 3,  maxWidth: null  },  // ~95% quality
    { qv: 8,  maxWidth: null  },  // ~75% quality
    { qv: 15, maxWidth: null  },  // ~50% quality
    { qv: 25, maxWidth: null  },  // ~25% quality
    { qv: 31, maxWidth: null  },  // minimum quality
    { qv: 15, maxWidth: 1920  },  // FHD width cap
    { qv: 25, maxWidth: 1280  },
    { qv: 31, maxWidth: 640   },
  ];

  for (const { qv, maxWidth } of attempts) {
    await new Promise((resolve, reject) => {
      let cmd = ffmpeg(inputPath);

      const filters = ['format=yuv420p'];
      if (maxWidth) {
        filters.push(`scale='if(gt(iw,${maxWidth}),${maxWidth},iw)':-2`);
      }
      cmd = cmd.videoFilters(filters);

      cmd
        .frames(1)
        .outputOptions([`-q:v ${qv}`])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    if (fileSize(outputPath) <= TARGET_SIZE) break;
  }

  return outputPath;
}

// ─── video compression ───────────────────────────────────────────────────────

/**
 * Compress a video to MP4, trimming to MAX_VIDEO_DURATION and targeting ≤ TARGET_SIZE.
 * Bitrate is calculated from the target file size and output duration.
 */
async function compressVideo(inputPath, sessionDir, originalName) {
  const baseName = path.parse(originalName).name;
  const outputPath = path.join(sessionDir, `${baseName}_compressed.mp4`);

  const meta = await getMetadata(inputPath);
  const srcDuration = meta.format.duration || 0;
  const duration = Math.min(srcDuration, MAX_VIDEO_DURATION);

  // Calculate bitrate: 10 MB × 0.95 safety margin ÷ duration
  const targetBitsTotal = TARGET_SIZE * 8 * 0.95;
  const audioBitrate = 128; // kbps
  const rawVideoBitrate = Math.floor(targetBitsTotal / duration / 1000) - audioBitrate;
  const videoBitrate = Math.min(Math.max(rawVideoBitrate, 100), 8000); // clamp 100 kbps–8 Mbps

  const encode = (vbr) =>
    new Promise((resolve, reject) =>
      ffmpeg(inputPath)
        .videoCodec('libx264')
        .videoBitrate(`${vbr}k`)
        .audioCodec('aac')
        .audioBitrate(`${audioBitrate}k`)
        .outputOptions([
          '-preset fast',
          '-movflags +faststart',
          '-pix_fmt yuv420p',
          '-t', String(duration),
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run()
    );

  await encode(videoBitrate);

  // If still over limit, proportionally reduce bitrate and retry once
  if (fileSize(outputPath) > TARGET_SIZE) {
    const ratio = (TARGET_SIZE * 0.9) / fileSize(outputPath);
    const reducedBitrate = Math.max(Math.floor(videoBitrate * ratio), 100);
    await encode(reducedBitrate);
  }

  return outputPath;
}

// ─── session store ───────────────────────────────────────────────────────────

const sessions = new Map(); // id → { createdAt, dir }

// Purge sessions older than 1 hour every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) {
      try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (_) {}
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

// ─── multer ──────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});

const upload = multer({
  storage,
  limits: { files: MAX_FILES, fileSize: MAX_INPUT_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = getExt(file.originalname);
    if (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`サポートされていないファイル形式: .${ext}`));
    }
  },
});

// ─── routes ──────────────────────────────────────────────────────────────────

// POST /api/compress
app.post('/api/compress', rateLimit, (req, res, next) => {
  upload.array('files', MAX_FILES)(req, res, (err) => {
    if (err) {
      const status = err.code === 'LIMIT_FILE_COUNT' ? 413 : 400;
      return res.status(status).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'ファイルがありません' });
  }

  const sessionId = uuidv4();
  const sessionDir = path.join(OUTPUT_DIR, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const results = [];

  for (const file of req.files) {
    try {
      const outputPath = isVideoFile(file.originalname)
        ? await compressVideo(file.path, sessionDir, file.originalname)
        : await compressImage(file.path, sessionDir, file.originalname);

      const compressed = fileSize(outputPath);
      const outputFilename = path.basename(outputPath);

      results.push({
        originalName: file.originalname,
        originalSize: file.size,
        compressedSize: compressed,
        downloadUrl: `/download/${sessionId}/${outputFilename}`,
        downloadName: outputFilename,
        type: isVideoFile(file.originalname) ? 'video' : 'image',
        success: true,
        underLimit: compressed <= TARGET_SIZE,
      });
    } catch (err) {
      console.error('Error processing file:', err.message);
      results.push({
        originalName: file.originalname,
        originalSize: file.size,
        error: err.message,
        success: false,
      });
    } finally {
      try { fs.unlinkSync(file.path); } catch (_) {}
    }
  }

  sessions.set(sessionId, { createdAt: Date.now(), dir: sessionDir });
  res.json({ sessionId, results });
});

// GET /download/:sessionId/:filename  — single file download
app.get('/download/:sessionId/:filename', rateLimit, (req, res) => {
  const { sessionId, filename } = req.params;

  // Validate sessionId is a known UUID in the session store
  if (!UUID_RE.test(sessionId) || !sessions.has(sessionId)) {
    return res.status(404).json({ error: 'セッションが見つかりません' });
  }

  // Ensure filename has no directory components
  if (path.basename(filename) !== filename || filename.length === 0) {
    return res.status(400).json({ error: '無効なファイル名' });
  }

  const session = sessions.get(sessionId);
  const filePath = path.join(session.dir, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'ファイルが見つかりません' });
  }

  res.download(filePath, filename);
});

// GET /download-all/:sessionId  — ZIP of all compressed files in the session
app.get('/download-all/:sessionId', rateLimit, (req, res) => {
  const { sessionId } = req.params;

  if (!UUID_RE.test(sessionId)) {
    return res.status(400).json({ error: '無効なセッション ID' });
  }

  const session = sessions.get(sessionId);
  if (!session || !fs.existsSync(session.dir)) {
    return res.status(404).json({ error: 'セッションが見つかりません' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="compressed.zip"');

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => {
    console.error('Archive error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'ZIP 作成中にエラーが発生しました' });
    } else {
      res.end();
    }
  });
  archive.pipe(res);
  archive.directory(session.dir, false);
  archive.finalize();
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});
