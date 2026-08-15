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
COPY api ./api
COPY src ./src

# Importers retain raw provider responses here. Mount it to keep the audit trail
# on the host; without a mount it lives only for the container's lifetime.
RUN mkdir -p /app/.local-data

ENV NODE_ENV=production
ENV TZ=UTC

# A failing flight refresh must not look healthy. Allow three five-minute cycles
# for transient provider trouble, but require a successful scheduled import.
HEALTHCHECK --interval=5m --timeout=10s --start-period=1m --retries=3 \
  CMD node -e "const{readFileSync}=require('node:fs');const s=JSON.parse(readFileSync('/app/.local-data/refresh-status.json'));const f=s.sources.find(x=>x.key==='flights');if(!f||f.status!=='ok'||Date.now()-Date.parse(f.lastSuccessAt)>900000)process.exit(1)"

ENTRYPOINT ["node", "scripts/refresh-daemon.mjs"]
