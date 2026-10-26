# Local PostgreSQL configuration

The application uses the standard PostgreSQL wire protocol and does not depend
on a Neon-specific driver. PostgreSQL 15 or newer is sufficient.

## 1. Prepare the server

Create a dedicated database and login. Use a generated password and substitute
the role/database names if required:

```sql
CREATE ROLE venn_fire_app LOGIN PASSWORD 'GENERATE-A-LONG-RANDOM-PASSWORD';
CREATE DATABASE venn_fire OWNER venn_fire_app;
```

The database must be reachable from the app container over TCP. Require TLS and use a certificate whose hostname matches the database hostname. Do not expose a plaintext PostgreSQL listener to the public internet.

A production URL can look like:

```text
postgresql://venn_fire_app:PASSWORD@db.example.org:5432/venn_fire?sslmode=verify-full
```

For the `venn-fire` server, the runtime also accepts the certificate-verified
parameter form without constructing a URL:

```text
PGHOST=<public IP or DNS>
PGPORT=41637
PGUSER=venn-fire
PGPASSWORD=<sensitive>
PGDATABASE=venn-fire
PG_CA_PEM=<sensitive PEM certificate>
PGSSL_SERVERNAME=venn-fire-postgres
```

When `PG_CA_PEM` is present this parameter form takes precedence over legacy
`DATABASE_URL`/`POSTGRES_URL` values. The CA accepts either real newlines or
escaped `\\n` sequences. TLS certificate verification, SNI and SCRAM channel
binding remain enabled.

The runtime defaults to five connections per process; the Docker Compose files configure ten.
Set `DATABASE_POOL_MAX=1` or `2` if the server has a low connection limit.

## 2. Create the schema

From a trusted machine with repository access:

```bash
DATABASE_URL='postgresql://…target…' pnpm db:bootstrap
```

For the parameter form, export the seven `PG*` values above and run
`pnpm db:bootstrap`; no database URL is needed.

This creates all current, historical, artifact and flight-history
tables idempotently. It also builds the compact public projections used by the
viewer if canonical rows already exist.

## 3. Copy an existing database

The source must permit reads for the duration of the copy.

```bash
SOURCE_DATABASE_URL='postgresql://…source…' \
TARGET_DATABASE_URL='postgresql://…target…' \
pnpm db:copy
```

`TARGET_DATABASE_URL` may be omitted when the target `PGHOST`, `PGPASSWORD` and
`PG_CA_PEM` parameter form is exported.

The copy runs in a repeatable-read source transaction, upserts all six
application tables, preserves JSONB and `bytea` artifacts, rebuilds the compact
public datasets, and verifies source/target row counts. It is idempotent and
does not delete unrelated target rows.

Tables copied:

- `app_datasets`
- `app_dataset_versions`
- `source_refresh_runs`
- `source_artifacts`
- `flight_import_runs`
- `flight_observations`

## 4. Run the local app

Configure the target database in the app container environment or Docker secrets, then rebuild the app. Keep database credentials out of Git and chat history. See [self-hosting-docker.md](self-hosting-docker.md) for a fresh stack, or use the existing host stack from `/srv/fire`:

```bash
docker compose -f docker-compose.yaml -f docker-compose.public.yaml up -d --build --no-deps app
docker compose exec app node scripts/refresh-once.mjs
curl -fsSL https://venn.apyos.com/api/data | jq '{ok, generatedAt}'
```

The server's internal timer runs source refreshes every five minutes when `REFRESH_ENABLED=true`. Keep the source database intact until current data, historical versions, raw artifacts and flight observations have been compared on the target.
