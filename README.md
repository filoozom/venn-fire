# Venn Fire Watch

Five-minute incident viewer for the High Fens wildfire near Drossart. The production site is [venn-fire.vercel.app](https://venn-fire.vercel.app).

## Data architecture

The browser is database-only. It paints the viewer shell immediately, starts `/api/data` as the application bundle executes, and hydrates the interface asynchronously. It repeats that read every five minutes with `cache: 'no-store'`; it never contacts a provider and has no bundled JSON fallback. All API routes also emit browser, CDN and Vercel-CDN `no-store` headers.

The production flow is:

```text
Vercel Queue delayed wake-up (every 5 min)
  → private /api/refresh-queue Vercel Function
  → per-source Postgres lease
  → fixed upstream provider
  → current dataset + historical version + refresh-run record
  → /api/data
  → five-minute browser timeline

GitHub fallback schedule / deployment push
  → zero-database /api/deployment revision probe
  → one public /api/refresh bootstrap/fallback call
  → the same leased refresh + next Vercel Queue wake-up
```

The PostgreSQL database is addressed through `DATABASE_URL`/`POSTGRES_URL` or the certificate-verified `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PG_CA_PEM` and `PGSSL_SERVERNAME` parameter form. The latter takes precedence when `PG_CA_PEM` is present. The runtime uses the standard PostgreSQL protocol, SCRAM channel binding and Vercel's database-pool lifecycle integration, and works with a TLS-enabled self-hosted server, PgBouncer endpoint or managed provider. Tables are created idempotently by the functions:

- `app_datasets`: latest normalized payload for each dataset.
- `app_dataset_versions`: immutable, content-addressed history when source content changes. Retrieval timestamps are excluded from the content hash.
- `app_public_datasets`: compact current projections for the viewer. Canonical rows remain complete; repeated aircraft provider strings and reproducible FIRMS footprint coordinates are omitted only from this delivery copy to reduce database transfer.
- `source_refresh_runs`: one status record for every claimed source/time bucket, including unchanged polls and errors.
- `refresh_scheduler_ticks`: one leased status row per deployment/wake-up slot, preventing duplicate queue messages from branching the refresh chain.
- `source_artifacts`: the content-addressed raw audit archive, including source API/feed responses and retained Sentinel quicklook bytes. Current counts and original-byte totals are reported by the database overview.
- `flight_import_runs` and `flight_observations`: exact, deduplicated receiver fixes retained for the incident lifetime.

The repository contains no data snapshots, raw-response directory or local refresh daemon. The deleted aircraft snapshot is recovered once from its immutable Git revision, validated as 51 exact observations, archived and idempotently inserted into Postgres; the migration record prevents another upstream request after it succeeds.

### Retained public-alert lookup

`/api/live-reports` returns the accumulated affected-area reports and BE-Alert CAP records, including alerts that have expired and disappeared from the live feed. Its optional `q` parameter searches the retained title, description, headline and area fields without changing the source data:

```bash
curl -fsSL 'https://venn-fire.vercel.app/api/live-reports?q=Ovifat' \
  | jq '.publicAlerts | {databaseRefreshedAt, currentlyInForce, totalAlertCount, matchCount, alerts}'
```

The equivalent read-only Postgres query is:

```sql
SELECT alert
FROM app_datasets AS dataset
CROSS JOIN LATERAL jsonb_array_elements(dataset.payload->'alerts') AS alert
WHERE dataset.dataset_key = 'public-alerts'
  AND concat_ws(' ',
    alert->>'title', alert->>'description', alert->>'headline',
    alert->>'capDescription', alert->>'areaDesc'
  ) ILIKE '%Ovifat%';
```

An empty result means no matching alert was accumulated; it does not prove that no alert was issued before collection began.

## Refresh sources

The scheduler has five-minute granularity. A database lease makes repeated calls in the same bucket no-ops, so website traffic or retrying automation cannot multiply upstream API usage.

| Source | Dataset | Provider interval |
| --- | --- | ---: |
| adsb.fi + ADSB.lol | One geographic point request per provider; verified aircraft and newly observed `GRZLY##` incident callsigns are selected inside 10 km, with exact receiver observations and every complete raw response retained | 5 min |
| ADSB.lol current traces | Exact trace catch-up for every retained incident aircraft—including G10, G12, G17, D-472 and D-604—recovering receiver fixes missed between live polls without interpolation | 30 min |
| Airplanes.live + ADSB.lol completed traces | Previous-day full-trace reconciliation for every retained incident aircraft; exact in-radius fixes and raw trace files retained | 6 h |
| Airplanes.live live API | Access-health check retained while the provider rejects server traffic, without consuming its limited allowance on repeated HTTP 403 responses | 60 min |
| Open-Meteo | Hourly model-grid temperature, humidity, wind and gust rows | 5 min |
| Governor of Liège + BRF | Strictly parsed affected-area reports and official incident events; stated effective time and bulletin publication time are retained separately | 5 min |
| Stavelot + Malmedy + Jalhay + Baelen + Eupen + Waimes + Bütgenbach + VHP + HLZ DG + Eifel Police | Official local-authority and emergency-service RSS/JSON/WordPress/HTML feeds; incident notices and raw source responses are retained | 5 min |
| Vedia JSON:API | Incident-filtered article metadata, source summaries, revision timestamps and raw API audit artifacts, always labelled local media | 5 min |
| BE-Alert CAP gateway | CAP alerts accumulated from the live feed, including records retained after expiry | 5 min |
| Walloon DATEX II adapter | Contract-gated road incidents, congestion, works and closures by credentialed pull or authenticated push | 5 min |
| Official-perimeter adapter | Agency GeoJSON perimeter snapshots by credentialed pull or authenticated push | 5 min |
| Public-operations adapter | Sanitized dispatch, water pickup/drop, closure, evacuation and aggregate-compliance events | 5 min |
| RMI Mont Rigi WFS | Ten-minute station temperature, humidity, precipitation, wind, gust and validation flags | 10 min |
| DWD CDC | Ten-minute wind observations and quality level from three nearby stations | 10 min |
| NASA FIRMS, five products | Exact VIIRS Suomi-NPP, VIIRS NOAA-20 and VIIRS NOAA-21 footprints, MODIS detections, plus GOES_NRT Meteosat detections with approximate viewing-geometry ground footprints | 15 min |
| Copernicus EMS | Rapid Mapping activation catalogue and any incident match details | 60 min |
| Copernicus Data Space | Sentinel-2 L2A catalogue metadata and public JPEG quicklook pixels archived as Postgres artifacts | 60 min |
| Copernicus EFFIS WFS | Daily algorithmic VIIRS geometry nearest the incident | 6 h |

FIRMS is checked by every scheduler run, but its provider lease is 15 minutes to conserve the limited NASA MAP_KEY allowance. Each successful poll merges exact detections into retained history instead of replacing the previous window and archives five raw product CSV responses in Postgres. The dataset reports both `generatedAt` (when FIRMS was queried) and `latestAcquiredAt` (the newest satellite scan or overpass returned). GOES_NRT is capped to a two-day request and returns Met12/Met10/Met9 over Belgium. Its `scan`/`track` columns are not physical kilometre dimensions: Met12 supplies zeroes while the MSG rows carry image-grid coordinates. The raw values are retained for provenance and ignored for footprint sizing. The map instead computes an explicitly approximate local ground footprint from the spacecraft generation, its EUMETSAT service longitude during this incident and the viewing geometry. Met12 and Met10 are at 0°; Met9 is at 45.5°E and therefore has a much larger, rotated footprint here. These rectangles communicate detection uncertainty and are never used for hectares. Configure `FIRMS_MAP_KEY` as a sensitive Vercel production environment variable; stored request URLs replace it with `MAP_KEY`, and the secret is never returned to the browser or written to the database.

Aircraft discovery does not add provider calls: the former fixed-hex request is replaced by one point request covering the incident. Exact Mode-S identities already verified for the incident remain accepted even when no callsign is broadcast; a previously unseen aircraft is accepted only when it broadcasts the conservative `GRZLY##` incident callsign pattern inside the radius. Once accepted, its identity is retained in Postgres and included in current- and previous-day trace reconciliation. Other nearby traffic remains archived in the raw provider artifact but is not normalized onto the incident map.

The Best estimate uses one solid red boundary and one matching area figure. It starts with the high-confidence, independently corroborated VIIRS core, then directly extends that same 50 m raster union with high-confidence pixels from the newest Terra/Aqua overpass that lie within 500 m of the core or aircraft-supported edge. Restricting MODIS to the newest supported pass prevents successive 1 km snapshots from accumulating into an inflated burn scar. Aircraft support is not a separate layer: repeated sharp `GRZLY##` direction changes within 3.5 km of the VIIRS core must be supported by another five-minute frame, and then bound the smallest lobe that can close against the existing thermal outline. That lobe is rasterised into the same union and therefore the same area figure; long reservoir-side/transit route legs are excluded. Receiver data has no payload or drop-state field, so this remains a conservative inference rather than proof of a water drop or confirmed fire front.

Bütgenbach's Cloudflare policy blocks requests from the Node.js function network. Its official sitemap and article pages are therefore read through `/api/butgenbach-source`, a no-store Vercel Edge function that accepts only short-lived HMAC-signed requests for allow-listed paths on `butgenbach.be`. It is not an open proxy; the Node.js refresh worker still validates, parses and archives every official response in Postgres.

The project is currently on Vercel Hobby, whose native cron frequency is not sufficient for five-minute work. A Vercel Queue message therefore wakes the private consumer at minute 02/07/12/... and schedules the next delayed message before polling providers. Queue delivery is durable and automatically retried. Push delivery is pinned to a deployment; the `refresh-scheduler` database record names the active deployment so an old chain stops after a release. `.github/workflows/refresh.yml` polls the zero-database `/api/deployment` probe while a release is moving, then calls the mutating refresh endpoint exactly once. Its 15-minute schedule remains a fallback. Push runs wait until the production alias reports their exact commit before taking ownership; a newer push cancels an older release wait that can no longer own the alias. Scheduled and manually dispatched fallback runs accept whichever valid deployment currently owns the production alias and never cancel a release run. A once-daily native Vercel cron provides an additional recovery path allowed by Hobby. Every refresh path activates the current deployment and schedules its next queue wake-up. The endpoint has no user-controlled URL or query target, and Postgres leases enforce the provider limits even if paths fire together.

## Local development

```bash
pnpm install
pnpm dev
```

Vite proxies only the read-only `/api/data` request to `https://venn-fire.vercel.app` by default, so local UI development works without a production database credential or bundled snapshot. Provider refresh and ingestion routes are not proxied. To read from another deployed/local API origin instead:

```bash
VENN_FIRE_DEV_DATA_ORIGIN=http://127.0.0.1:3000 pnpm dev
```

Run the deterministic checks with:

```bash
pnpm verify:refresh
pnpm verify:flight-history
pnpm verify:aircraft-fire-edge
pnpm verify:map-tracks
pnpm verify:firms-sensors
pnpm verify:postgres
pnpm verify:live-reports
pnpm build
```

Production browser checks can be run with:

```bash
pnpm visual-check https://venn-fire.vercel.app
pnpm verify:timeline https://venn-fire.vercel.app
```

## Deployment

The repository is linked to the Vercel project `venn-fire`. A push to `main` starts the build workflow and Vercel deployment; an explicit production deploy is also available:

```bash
git push origin main
pnpm dlx vercel@latest --prod --yes
```

Required production variables:

- `DATABASE_URL`/`POSTGRES_URL`, or `PGHOST` + `PGPASSWORD` + `PG_CA_PEM` (with optional `PGPORT`, `PGUSER`, `PGDATABASE` and `PGSSL_SERVERNAME`)
- `FIRMS_MAP_KEY`
- `INTERNAL_SOURCE_TOKEN` (sensitive; authenticates the fixed-host Bütgenbach Edge fetcher)

For a self-hosted cutover, schema bootstrap, full history/artifact copy and Vercel environment replacement are documented in [`docs/self-hosted-postgres.md`](docs/self-hosted-postgres.md). The source database must allow one final read; the copy cannot bypass a provider-level quota suspension.

Optional controlled-source variables:

- Walloon road pull: `WALLONIA_DATEX_URL` plus either `WALLONIA_DATEX_USERNAME`/`WALLONIA_DATEX_PASSWORD` or `WALLONIA_DATEX_AUTHORIZATION`.
- Field perimeter pull: `INCIDENT_PERIMETER_URL` and optional `INCIDENT_PERIMETER_AUTHORIZATION`.
- Sanitized operations pull: `PUBLIC_OPERATIONS_URL` and optional `PUBLIC_OPERATIONS_AUTHORIZATION`.
- Provider/agency push: `CONTROLLED_SOURCE_INGEST_TOKEN`. Providers POST with `Authorization: Bearer …` to `/api/ingest-controlled?source=road-events`, `official-perimeter` or `public-operations`.

The source registry exposes only whether each adapter is configured; URLs issued privately by agencies, usernames, passwords, authorization headers and the ingestion token are never returned to the browser. Road pushes accept DATEX II XML, perimeter pushes accept WGS84 GeoJSON Polygon/MultiPolygon features, and operations pushes accept a publishable JSON `events` array. Raw CAD/radio traffic and personal evacuation-compliance records must not be sent; only agency-approved sanitized events and aggregate counts are accepted.

Known source limits are stored in `source-registry` and shown in the Data & Sources modal. The currently unconnected data is: the official Walloon DATEX II road feed, a field-confirmed fire-service/crisis-centre perimeter and an agency-approved sanitized operations feed; each already has a five-minute pull/push adapter but still needs access or an export. BE-Alert records that expired before collection cannot be reconstructed without an archive; analysis-ready Sentinel multispectral processing needs Copernicus OAuth credentials; raw CAD/radio is non-public and potentially sensitive; and personal-level evacuation compliance is intentionally excluded.

Do not add a CDN cache in front of `/api/data`, `/api/live-reports`, `/api/live-situation`, `/api/firms-situation` or `/api/refresh`.

## Interpretation limits

- The five-minute timeline carries the latest sourced value forward; it never interpolates a new measurement.
- FIRMS pixels are thermal anomalies, not a burned-area perimeter. Standalone per-sensor figures remain separate and MODIS/Meteosat receive no standalone area. The Best estimate explicitly unions its corroborated VIIRS core, only the qualifying pixels from the newest high-confidence MODIS pass and any repeat-supported conservative aircraft lobe; its displayed area is the area of that same solid 50 m raster outline. Meteosat never contributes.
- EFFIS is a daily algorithmic VIIRS geometry, not a field-surveyed operational perimeter or within-day progression.
- Aircraft markers and gap-limited connectors represent exact receiver observations, fade linearly and disappear after 24 hours. Coverage gaps remain gaps; no route, water pickup or drop is inferred. Repeated near-core `GRZLY##` direction changes may extend the same solid Best estimate union under the repeat-support rule, but do not establish a confirmed perimeter.
- RMI and DWD station values remain separate from the Open-Meteo model. Near-real-time quality-control status is retained.
- Copernicus EMS is a discovery catalogue. No EMS match means no matching activation was found in the current catalogue, not that operational mapping does not exist elsewhere. Sentinel-2 records include catalogue metadata and retained public JPEG quicklooks; they are not analysis-ready multispectral bands or a derived burn product.
- Municipal notices can report closures and evacuation guidance, but no agency feed is currently connected for a field-confirmed perimeter/fireline progression, live DATEX road state, suppression-resource dispatch, water pickup/drop events or aggregate evacuation compliance. Ready adapters remain empty until access or an agency-approved export is supplied. Raw CAD/radio and personal identities are intentionally excluded.
- This viewer is informational, not an emergency service. Follow BE-Alert and local authorities.
