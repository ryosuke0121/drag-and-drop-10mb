FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user and group
RUN groupadd -r appuser && useradd -r -g appuser appuser

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Create runtime directories and set ownership
RUN mkdir -p /tmp/dnd-uploads /tmp/dnd-outputs && \
    chown -R appuser:appuser /app /tmp/dnd-uploads /tmp/dnd-outputs

# Switch to non-root user
USER appuser

EXPOSE 3000

CMD ["node", "server.js"]
