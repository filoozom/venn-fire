# Build the client and resolve dependencies with the pinned pnpm version.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV CI=1
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    PNPM_HOME=/pnpm pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Resolve production-only dependencies separately so the runtime image carries
# no build toolchain: vite, react and playwright stay out of it.
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
ENV CI=1
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    PNPM_HOME=/pnpm pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --prod

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    CLIENT_ROOT=/app/dist \
    DATABASE_APPLICATION_NAME=venn-fire-selfhosted
# tini reaps zombies and forwards SIGTERM, so the server's graceful shutdown
# actually runs and the Postgres pool is closed on `docker stop`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY api ./api
COPY server ./server
# Some detection logic is shared between the client and the ingest pipeline:
# server/refresh-sources.mjs, server/sentinel-analysis.mjs and
# api/firms-situation.js all import ../src/firmsDetections.js. The whole
# directory is 368 KB, so it is copied wholesale rather than kept as an
# allowlist that would silently drift.
COPY src ./src
# Operator entry points: seeding a fresh database and running a refresh by hand.
COPY scripts/refresh-once.mjs scripts/seed-incident-config.mjs ./scripts/

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/standalone.mjs"]
