FROM node:22-alpine

WORKDIR /app

RUN addgroup -g 1001 -S ari && adduser -S ari -u 1001 -G ari

# Install dependencies first (better caching)
RUN apk add --no-cache python3 py3-pip
COPY package.json package-lock.json* ./
COPY scripts/ensure-mem0-peer-stubs.js ./scripts/ensure-mem0-peer-stubs.js
COPY agno_runtime/requirements.txt ./agno_runtime/requirements.txt
RUN npm ci --omit=dev --legacy-peer-deps
RUN python3 -m venv /opt/ari-agno && \
    /opt/ari-agno/bin/pip install --no-cache-dir -r agno_runtime/requirements.txt

ENV ARI_AGNO_PYTHON=/opt/ari-agno/bin/python \
    ARI_SESSION_ATTACHMENT_DIR=/app/.ari-session-attachments \
    ARI_AGENT_FILE_MAX_COUNT=10 \
    ARI_AGENT_FILE_MAX_BYTES=26214400 \
    ARI_AGENT_FILE_TOTAL_MAX_BYTES=52428800

# Copy application code
COPY --chown=ari:ari . .

# Create runtime-owned local directories
RUN mkdir -p logs .ari-session-attachments && \
    chown ari:ari logs .ari-session-attachments
USER ari

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --header='x-forwarded-proto: https' -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
