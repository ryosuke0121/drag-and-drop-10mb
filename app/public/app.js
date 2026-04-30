'use strict';

const MAX_FILES = 10;
const TARGET_MB = 10;
const IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'heic', 'heif', 'avif',
]);
const VIDEO_EXTS = new Set([
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'mts',
]);

// ─── state ───────────────────────────────────────────────────────────────────
let selectedFiles = []; // File objects
let currentSessionId = null;

// ─── DOM ─────────────────────────────────────────────────────────────────────
const dropZone      = document.getElementById('dropZone');
const fileInput     = document.getElementById('fileInput');
const fileListEl    = document.getElementById('fileList');
const actionBar     = document.getElementById('actionBar');
const clearBtn      = document.getElementById('clearBtn');
const compressBtn   = document.getElementById('compressBtn');
const progressSec   = document.getElementById('progressSection');
const progressSub   = document.getElementById('progressSub');
const resultsSec    = document.getElementById('resultsSection');
const resultsList   = document.getElementById('resultsList');
const downloadAllBtn = document.getElementById('downloadAllBtn');
const newBtn        = document.getElementById('newBtn');

// ─── utilities ────────────────────────────────────────────────────────────────
const getExt = (name) => name.split('.').pop().toLowerCase();
const isImage = (name) => IMAGE_EXTS.has(getExt(name));
const isVideo = (name) => VIDEO_EXTS.has(getExt(name));

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

// ─── file management ──────────────────────────────────────────────────────────
function validateAndAdd(files) {
  const errors = [];

  for (const file of files) {
    const ext = getExt(file.name);
    if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) {
      errors.push(`「${file.name}」はサポートされていない形式です`);
      continue;
    }
    if (selectedFiles.length >= MAX_FILES) {
      errors.push(`ファイルは最大 ${MAX_FILES} 個まで選択できます`);
      break;
    }
    // Avoid duplicates (by name + size)
    const dup = selectedFiles.some((f) => f.name === file.name && f.size === file.size);
    if (!dup) selectedFiles.push(file);
  }

  if (errors.length) alert(errors.join('\n'));
  renderFileList();
}

function renderFileList() {
  fileListEl.innerHTML = '';

  if (selectedFiles.length === 0) {
    hide(fileListEl);
    hide(actionBar);
    return;
  }

  for (let i = 0; i < selectedFiles.length; i++) {
    const file = selectedFiles[i];
    const ext  = getExt(file.name);
    const icon = isVideo(file.name) ? '🎬' : '🖼️';
    const li   = document.createElement('li');

    // Video duration warning is handled server-side; show a hint here
    const warnHtml = isVideo(file.name)
      ? '<span class="file-warn">⏱ 1分超えは自動カット</span>'
      : '';

    li.innerHTML = `
      <span class="file-icon">${icon}</span>
      <span class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      <span class="file-size">${formatBytes(file.size)}</span>
      ${warnHtml}
      <button class="remove-btn" data-index="${i}" aria-label="削除">✕</button>
    `;
    fileListEl.appendChild(li);
  }

  fileListEl.querySelectorAll('.remove-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedFiles.splice(Number(btn.dataset.index), 1);
      renderFileList();
    });
  });

  show(fileListEl);
  show(actionBar);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── drag-and-drop ────────────────────────────────────────────────────────────
['dragenter', 'dragover'].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  });
});
dropZone.addEventListener('drop', (e) => {
  const files = Array.from(e.dataTransfer.files);
  validateAndAdd(files);
});
dropZone.addEventListener('click', (e) => {
  if (e.target === fileInput || e.target.tagName === 'LABEL') return;
  fileInput.click();
});
fileInput.addEventListener('change', () => {
  validateAndAdd(Array.from(fileInput.files));
  fileInput.value = '';
});

// ─── clear ────────────────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  selectedFiles = [];
  renderFileList();
  hide(resultsSec);
  currentSessionId = null;
});

newBtn.addEventListener('click', () => {
  selectedFiles = [];
  renderFileList();
  hide(resultsSec);
  currentSessionId = null;
});

// ─── compress ────────────────────────────────────────────────────────────────
compressBtn.addEventListener('click', async () => {
  if (selectedFiles.length === 0) return;

  // UI: disable controls, show progress
  compressBtn.disabled = true;
  clearBtn.disabled    = true;
  hide(actionBar);
  hide(fileListEl);
  hide(resultsSec);
  show(progressSec);
  progressSub.textContent = `${selectedFiles.length} 個のファイルを処理しています…`;

  const formData = new FormData();
  selectedFiles.forEach((f) => formData.append('files', f));

  try {
    const resp = await fetch('/api/compress', {
      method: 'POST',
      body: formData,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || 'サーバーエラー');
    }

    const data = await resp.json();
    currentSessionId = data.sessionId;
    renderResults(data.results);

    hide(progressSec);
    show(resultsSec);
  } catch (err) {
    hide(progressSec);
    show(actionBar);
    show(fileListEl);
    alert(`圧縮中にエラーが発生しました：\n${err.message}`);
  } finally {
    compressBtn.disabled = false;
    clearBtn.disabled    = false;
  }
});

// ─── results ─────────────────────────────────────────────────────────────────
function renderResults(results) {
  resultsList.innerHTML = '';

  for (const r of results) {
    const li = document.createElement('li');
    li.className = 'result-item';

    if (!r.success) {
      li.classList.add('error');
      li.innerHTML = `
        <div class="result-row">
          <span class="result-icon">❌</span>
          <span class="result-name" title="${escapeHtml(r.originalName)}">${escapeHtml(r.originalName)}</span>
          <span class="result-badge badge-err">エラー</span>
        </div>
        <div class="result-dl"><span class="result-reduction">${escapeHtml(r.error || '処理に失敗しました')}</span></div>
      `;
    } else {
      const reduction = Math.round((1 - r.compressedSize / r.originalSize) * 100);
      const overLimit = !r.underLimit;
      const icon = r.type === 'video' ? '🎬' : '🖼️';
      const badge = overLimit
        ? '<span class="result-badge badge-over">10MB超</span>'
        : '<span class="result-badge badge-ok">✔ 10MB以下</span>';

      if (overLimit) li.classList.add('warning');

      li.innerHTML = `
        <div class="result-row">
          <span class="result-icon">${icon}</span>
          <span class="result-name" title="${escapeHtml(r.originalName)}">${escapeHtml(r.originalName)}</span>
          <div class="result-sizes">
            <span>${formatBytes(r.originalSize)}</span>
            <span class="arrow">→</span>
            <span class="new-size ${overLimit ? 'over' : ''}">${formatBytes(r.compressedSize)}</span>
          </div>
          ${badge}
        </div>
        <div class="result-dl">
          <span class="result-reduction">${reduction >= 0 ? `${reduction}% 削減` : `${-reduction}% 増加`}</span>
          <a
            href="${escapeHtml(r.downloadUrl)}"
            download="${escapeHtml(r.downloadName)}"
            class="btn btn-outline"
          >⬇ ダウンロード</a>
        </div>
      `;
    }

    resultsList.appendChild(li);
  }
}

// ─── download all ─────────────────────────────────────────────────────────────
downloadAllBtn.addEventListener('click', () => {
  if (!currentSessionId) return;
  const a = document.createElement('a');
  a.href = `/download-all/${currentSessionId}`;
  a.download = 'compressed.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});
