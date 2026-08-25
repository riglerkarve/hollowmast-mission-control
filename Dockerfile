# Mission Control container image.
# Node 24 is intentional: Mission Control uses node:sqlite.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    MC_DB_PATH=/app/data/dashboard.db

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY tools ./tools

RUN mkdir -p /app/data /app/logs \
    && chown -R node:node /app

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/status').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/index.js"]
