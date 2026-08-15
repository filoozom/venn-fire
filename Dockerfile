# Data-refresh daemon for the Venn fire viewer.
#
# This image runs the importers only. It does not build or serve the site, which
# Vercel does. Every importer uses Node built-ins and the local src modules, so
# there are no dependencies to install and no lockfile to honour here.

FROM node:22-alpine

WORKDIR /app

# Copied so the image can run standalone. docker-compose bind-mounts these over
# the top for live development, which is why nothing is built at this stage.
COPY package.json ./
COPY scripts ./scripts
COPY src ./src

# Importers retain raw provider responses here. Mount it to keep the audit trail
# on the host; without a mount it lives only for the container's lifetime.
RUN mkdir -p /app/.local-data

ENV NODE_ENV=production
ENV TZ=UTC

# A failing refresh must not look healthy. The daemon rewrites its status file on
# every tick that does work, so a stale file means it has stopped making progress.
HEALTHCHECK --interval=5m --timeout=10s --start-period=1m --retries=3 \
  CMD node -e "const{statSync}=require('node:fs');const age=Date.now()-statSync('/app/.local-data/refresh-status.json').mtimeMs;if(age>3600000)process.exit(1)" || exit 1

ENTRYPOINT ["node", "scripts/refresh-daemon.mjs"]
