# Venn Fire Watch

Five-minute incident viewer for the High Fens wildfire near Drossart. The production site is [venn-fire.vercel.app](https://venn-fire.vercel.app).

## Data architecture

The browser is database-only. It calls `/api/data` immediately and every five minutes with `cache: 'no-store'`; it never contacts a provider and has no bundled JSON fallback. All API routes also emit browser, CDN and Vercel-CDN `no-store` headers.

The production flow is:

```text
GitHub schedule (every 5 min)
  → /api/refresh Vercel Function
  → per-source Postgres lease
  → fixed upstream provider
  → current dataset + historical version + refresh-run record
  → /api/data
  → five-minute browser timeline
```

The linked serverless Postgres database is addressed through `DATABASE_URL` or `POSTGRES_URL`. Tables are created idempotently by the functions:

- `app_datasets`: latest normalized payload for each dataset.
- `app_dataset_versions`: immutable, content-addressed history when source content changes. Retrieval timestamps are excluded from the content hash.
- `source_refresh_runs`: one status record for every claimed source/time bucket, including unchanged polls and errors.
- `source_artifacts`: the migrated compressed raw audit archive. The completed migration contains 147 artifacts representing 23,679,948 original bytes.
- `flight_import_runs` and `flight_observations`: exact, deduplicated receiver fixes with 30-day live retention.

The repository contains no data snapshots, raw-response directory or local refresh daemon. Reviewed incident configuration and all former local snapshots were seeded into Postgres before their local removal.

## Refresh sources

The scheduler has five-minute granularity. A database lease makes repeated calls in the same bucket no-ops, so website traffic or retrying automation cannot multiply upstream API usage.

| Source | Dataset | Provider interval |
| --- | --- | ---: |
| adsb.fi + ADSB.lol | Incident aircraft observations | 5 min |
| Open-Meteo | Grid weather | 5 min |
| Governor of Liège + BRF | Affected-area reports | 5 min |
| BE-Alert CAP gateway | Public alerts | 5 min |
| RMI Mont Rigi WFS | Station weather | 10 min |
| DWD CDC | Nearby wind stations | 10 min |
| NASA FIRMS, four sensors | Thermal detections | 15 min |
| Copernicus EMS | Rapid Mapping activations | 60 min |
| Copernicus Data Space | Sentinel-2 catalogue | 60 min |
| Copernicus EFFIS WFS | Daily burned-area geometry | 6 h |

FIRMS is checked by every scheduler run, but its provider lease is 15 minutes to conserve the limited NASA MAP_KEY allowance. Each successful poll merges exact detections into retained history instead of replacing the previous window. Configure `FIRMS_MAP_KEY` as a sensitive Vercel production environment variable; the value is never returned to the browser or stored in a dataset.

The project is currently on Vercel Hobby, whose native cron frequency is not sufficient for five-minute work. `.github/workflows/refresh.yml` therefore wakes the Vercel refresh function every five minutes. The refresh endpoint has no user-controlled URL or query target, and Postgres leases enforce the provider limits.

## Local development

```bash
pnpm install
pnpm dev
```

Local UI development still requires access to a deployed `/api/data` route or a local Vercel environment with a database connection. There is intentionally no static fallback.

Run the deterministic checks with:

```bash
pnpm verify:refresh
pnpm verify:flight-history
pnpm verify:live-reports
pnpm build
```

Production browser checks can be run with:

```bash
pnpm visual-check -- https://venn-fire.vercel.app
pnpm verify:timeline -- https://venn-fire.vercel.app
```

## Deployment

The repository is linked to the Vercel project `venn-fire`. A push to `main` starts the build workflow and Vercel deployment; an explicit production deploy is also available:

```bash
git push origin main
pnpm dlx vercel@latest --prod --yes
```

Required production variables:

- `DATABASE_URL` or `POSTGRES_URL`
- `FIRMS_MAP_KEY`

Do not add a CDN cache in front of `/api/data`, `/api/live-situation`, `/api/firms-situation` or `/api/refresh`.

## Interpretation limits

- The five-minute timeline carries the latest sourced value forward; it never interpolates a new measurement.
- FIRMS pixels are thermal anomalies, not a burned-area perimeter. Independent sensors are never summed or averaged, and MODIS does not receive a hectare estimate at this incident scale.
- EFFIS is a daily algorithmic VIIRS geometry, not a field-surveyed operational perimeter or within-day progression.
- Aircraft markers represent exact receiver observations within the preceding five minutes. Coverage gaps remain gaps; no route, water pickup or drop is inferred.
- RMI and DWD station values remain separate from the Open-Meteo model. Near-real-time quality-control status is retained.
- This viewer is informational, not an emergency service. Follow BE-Alert and local authorities.
