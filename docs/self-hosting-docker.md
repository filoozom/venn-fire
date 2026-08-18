# Self-hosting with Docker

The container replaces four things Vercel provides: the serverless functions in
`api/`, the static hosting of the built client, the daily cron, and the queue
chain that drives the five-minute source refresh. One long-lived Node process
does all four, so the queue and its deployment bookkeeping are not needed.

The same handler files serve both platforms. `server/vercel-adapter.mjs` supplies
the two things Vercel's runtime adds and Node's `http` server does not: a parsed
`request.query`, and `response.status()` / `response.json()`.

## Quick start

```bash
cp .env.docker.example .env       # set POSTGRES_PASSWORD
docker compose up -d --build
```

Then **seed the incident definition** — the deployment is not usable without it:

```bash
docker compose exec app node scripts/seed-incident-config.mjs https://venn-fire.vercel.app
docker compose exec app node scripts/refresh-once.mjs
```

Open <http://localhost:3000>.

### Why seeding is required

`incident-config` is configuration, not an ingested source. It holds the incident
centre, the timeline start, the flight roster, the initial layer choices and the
map labels. `refreshAllSources` reads it and refuses to invent one, so on an
empty database the `incident-map-context` source fails and the viewer has no
timeline to draw. `/api/data` returns 503 until it exists.

Two ways to provide it:

- `scripts/seed-incident-config.mjs <origin-url | file.json>` — pulls it from any
  running deployment's public `/api/data`, which is all you need from the origin.
- `pnpm db:copy` with `SOURCE_DATABASE_URL` and `TARGET_DATABASE_URL` — copies
  every table, including the artifact and flight history. Needs Postgres
  credentials for the origin.

## Configuration

`docker compose` reads `.env` from the project directory automatically.

| Variable | Default | Purpose |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | — | Required. Used by both services. |
| `POSTGRES_USER` / `POSTGRES_DB` | `venn-fire` | Database identity. |
| `APP_PORT` | `3000` | Host port for the app. |
| `DATABASE_URL` | set by compose | Any Postgres URL if you bring your own server. |
| `FIRMS_MAP_KEY` | empty | NASA FIRMS key. See the caveat below. |
| `RUN_MIGRATIONS` | `true` | Create and migrate the schema on start. |
| `REFRESH_ENABLED` | `true` | Internal five-minute refresh loop. |
| `REFRESH_ON_BOOT` | `false` | Refresh immediately instead of at the next slot. |
| `DATABASE_POOL_MAX` | `10` | Pool size per process. |
| `TZ` | `Europe/Brussels` | Container time zone. |

To use an existing Postgres server instead of the bundled one, drop the
`postgres` service and set `DATABASE_URL`. `server/postgres.mjs` also accepts
`PGHOST` / `PGPASSWORD` / `PG_CA_PEM` for a TLS-pinned server; see
[self-hosted-postgres.md](self-hosted-postgres.md).

## Operations

```bash
docker compose logs -f app                            # structured JSON lines
curl localhost:3000/healthz                           # liveness + database reachability
docker compose exec app node scripts/refresh-once.mjs # refresh now
```

The server logs one JSON object per event (`listening`, `schema-ready`,
`refresh-scheduled`, `refresh-complete`, `refresh-failed`). A failing source is
logged and skipped; it never takes the web server down.

To drive the cadence from your own scheduler instead, set `REFRESH_ENABLED=false`
and run `scripts/refresh-once.mjs` from cron. Overlapping runs are safe — the
refresh claims each source in Postgres — but the in-process loop also declines to
start a second pass while one is still running.

### Backups

All state is in Postgres, in the `postgres-data` volume. Nothing is kept on the
app container's filesystem.

```bash
docker compose exec -T postgres pg_dump -U venn-fire venn-fire | gzip > backup.sql.gz
```

## Serving

The server handles compression and cache headers itself, so it can be exposed
directly, though a reverse proxy is still the right place for TLS:

- `/assets/*` is fingerprinted by Vite and served `immutable` for a year.
- `index.html` and the files from `public/` revalidate against an ETag.
- Text responses are brotli or gzip encoded per `Accept-Encoding`, compressed
  once and cached in memory for the life of the container.
- `/api/data` compresses its own body and answers `If-None-Match` with 304.
  See the reasoning in `server/http-response.mjs`.

## Differences from the Vercel deployment

- **No queue.** The refresh chain in `server/refresh-scheduler.mjs` and the
  `/api/refresh` and `/api/refresh-queue` endpoints are Vercel-only; both require
  `VERCEL_DEPLOYMENT_ID`. The container uses the shared cadence in
  `server/refresh-cadence.mjs` directly.
- **`/api/butgenbach-source` is not routed.** It exists to give Vercel functions
  a fixed egress identity. Off-platform, `fetchButgenbachBody` already fetches
  the official URL directly.
- **Single process.** `DATABASE_POOL_MAX` is one pool, not one per warm function
  instance, so it can be larger than the Vercel value.

## Caveat: `FIRMS_MAP_KEY`

Without a key the `firms` source fails and the dataset can be left in a reduced
shape that has detections but no `locationReference`, `bbox` or sensor
summaries. The viewer now falls back to the incident centre for its footprint
projection, so it renders either way, but sensor-level areas and the FIRMS
interpretation panel stay empty. Request a key at
<https://firms.modaps.eosdis.nasa.gov/api/map_key/>.

On a brand-new database the one-time `firms-history` backfill runs in the same
pass as the first `firms` fetch and can overwrite the richer payload. Running
`scripts/refresh-once.mjs` again after the backfill has been recorded restores
the full shape.

## Deploying behind an existing Traefik

`docker-compose.traefik.yml` is the variant for a host that already runs Traefik
and already has a database. It defines **only the app container**: no postgres
service, no volume, no published ports. Traefik reaches it over the shared
network, and the container never writes to the host filesystem.

```bash
# on the target host, inside the deployment directory
cat > .env <<'ENV'
DATABASE_URL=postgres://user:password@host:5432/database
TRAEFIK_NETWORK=traefik           # docker network ls
TRAEFIK_ENTRYPOINT=websecure
TRAEFIK_CERT_RESOLVER=letsencrypt
APP_HOST=venn.apyos.com
REFRESH_ENABLED=false             # see below
FIRMS_MAP_KEY=
ENV

docker compose -f docker-compose.traefik.yml up -d --build
docker compose -f docker-compose.traefik.yml logs -f app
```

Confirm the three Traefik values against the running proxy before the first
start; the defaults are guesses, not discovered values:

```bash
docker network ls
docker inspect <traefik-container> | grep -iE 'entrypoints|certresolver'
```

### Which instance refreshes

`REFRESH_ENABLED` defaults to **false** here. Two deployments refreshing one
database is the only way this can disturb existing data. The refresh does claim
each source per five-minute bucket in `source_refresh_runs`, so a race is
contained rather than corrupting, but there is no reason to run two writers.
Enable it on exactly one instance:

- Keeping Vercel as the writer: leave `REFRESH_ENABLED=false`. The container is
  then a pure reader and cannot modify anything but its own connection.
- Cutting over to the container: disable the Vercel cron, then set
  `REFRESH_ENABLED=true` and restart.

`RUN_MIGRATIONS=true` is safe against a populated database. Every statement is
`CREATE TABLE IF NOT EXISTS` or an additive index; there is no `DROP`,
`TRUNCATE`, `DELETE` or column-altering migration anywhere in the schema path.
Set it to `false` if you would rather the container issue no DDL at all.

### Cloudflare in front

The app emits its own cache-control and compression per route, so Cloudflare
should be left to pass those through rather than overriding them. Two things to
check:

- The `/api/data` response carries `s-maxage=60, stale-while-revalidate=300` and
  an `ETag`. Cloudflare honouring it is a bonus, not a requirement.
- `/api/source-image` responses are `immutable` for a year and safe to cache
  aggressively; their URLs contain a content hash.

Visitor IPs arrive as `CF-Connecting-IP`. Nothing in the app reads the client
address, so no trusted-proxy configuration is needed for correctness.
