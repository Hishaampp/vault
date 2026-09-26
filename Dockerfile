# syntax=docker/dockerfile:1
# Production image for Vault: the dashboard is built once, then served by the
# Node.js gateway, which also runs the storage and metadata processes.

# ---- build the dashboard ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- runtime: production dependencies only, non-root user ----
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/engine ./src/engine
COPY tsconfig.json ./
# data lives in a directory the unprivileged user owns; nothing else is writable
RUN mkdir -p /app/.vault-data && chown -R node:node /app/.vault-data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
CMD ["node", "--import", "tsx", "server/main.ts"]