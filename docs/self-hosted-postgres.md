# Self-hosted PostgreSQL cutover

The application uses the standard PostgreSQL wire protocol and does not depend
on a Neon-specific driver. PostgreSQL 15 or newer is sufficient.

## 1. Prepare the server

Create a dedicated database and login. Use a generated password and substitute
the role/database names if required:

```sql
CREATE ROLE venn_fire_app LOGIN PASSWORD 'GENERATE-A-LONG-RANDOM-PASSWORD';
CREATE DATABASE venn_fire OWNER venn_fire_app;
```

The endpoint must be reachable from Vercel Functions over TCP. Require TLS and
use a certificate whose hostname matches the database hostname. Do not expose a
plaintext PostgreSQL listener to the public internet. For sustained serverless
traffic, put PgBouncer in transaction-pooling mode in front of PostgreSQL.

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
binding remain enabled. Vercel's function lifecycle is attached to each pool.

The runtime defaults to five connections per warm Vercel function instance.
Set `DATABASE_POOL_MAX=1` or `2` if the server has a low connection limit.

## 2. Create the schema

From a trusted machine with repository access:

```bash
DATABASE_URL='postgresql://…target…' pnpm db:bootstrap
```

For the parameter form, export the seven `PG*` values above and run
`pnpm db:bootstrap`; no database URL is needed.

This creates all current, historical, artifact, scheduler and flight-history
tables idempotently. It also builds the compact public projections used by the
viewer if canonical rows already exist.

## 3. Copy the Neon database

The source must permit reads for the duration of the copy. Neon Free suspends
compute after its transfer allowance is exhausted, so temporarily upgrading the
source or supplying a provider export is required before this step can work.

```bash
SOURCE_DATABASE_URL='postgresql://…old Neon…' \
TARGET_DATABASE_URL='postgresql://…target…' \
pnpm db:copy
```

`TARGET_DATABASE_URL` may be omitted when the target `PGHOST`, `PGPASSWORD` and
`PG_CA_PEM` parameter form is exported.

The copy runs in a repeatable-read source transaction, upserts all seven
application tables, preserves JSONB and `bytea` artifacts, rebuilds the compact
public datasets, and verifies source/target row counts. It is idempotent and
does not delete unrelated target rows.

Tables copied:

- `app_datasets`
- `app_dataset_versions`
- `source_refresh_runs`
- `refresh_scheduler_ticks`
- `source_artifacts`
- `flight_import_runs`
- `flight_observations`

## 4. Cut Vercel over

Add the target `PG*` variables above as sensitive Production variables, then
redeploy. `PG_CA_PEM` deliberately takes precedence, so the old Neon URL can be
kept temporarily for rollback and removed after verification. Keep the provider
credentials unchanged.

```bash
pnpm dlx vercel@latest env add PGHOST production
pnpm dlx vercel@latest env add PGPORT production
pnpm dlx vercel@latest env add PGUSER production
pnpm dlx vercel@latest env add PGPASSWORD production
pnpm dlx vercel@latest env add PGDATABASE production
pnpm dlx vercel@latest env add PG_CA_PEM production
pnpm dlx vercel@latest env add PGSSL_SERVERNAME production
pnpm dlx vercel@latest --prod --yes
```

Enter the URL only at the CLI prompt or in the Vercel dashboard; do not commit
it or paste it into issue/chat history. Verify before decommissioning Neon:

```bash
curl -fsSL https://venn-fire.vercel.app/api/data | jq '{ok, generatedAt}'
curl -fsSL https://venn-fire.vercel.app/api/refresh | jq '{ok, sources, database}'
```

The refresh call activates the deployed revision and resumes the five-minute
queue chain. Keep Neon intact until current data, historical versions, raw
artifacts and flight observations have all been compared on the target.
