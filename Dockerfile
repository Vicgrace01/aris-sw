FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
# Toolchain for node-gyp fallback of native modules (better-sqlite3).
# The prebuilt binary is tried first; this only compiles if the download fails.
# Kept in the deps stage only so the runtime image stays slim.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM base AS runtime
ENV NODE_ENV=production PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/data/persist && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node scripts/healthcheck.mjs || exit 1
CMD ["node", "server.js"]