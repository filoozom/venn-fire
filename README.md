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
  → public /api/refresh bootstrap and fallback
  → the same leased refresh + next Vercel Queue wake-up
```

The linked serverless Postgres database is addressed through `DATABASE_URL` or `POSTGRES_URL`. Tables are created idempotently by the functions:

- `app_datasets`: latest normalized payload for each dataset.
- `app_dataset_versions`: immutable, content-addressed history when source content changes. Retrieval timestamps are excluded from the content hash.
- `source_refresh_runs`: one status record for every claimed source/time bucket, including unchanged polls and errors.
- `refresh_scheduler_ticks`: one leased status row per deployment/wake-up slot, preventing duplicate queue messages from branching the refresh chain.
- `source_artifacts`: the content-addressed raw audit archive, including source API/feed responses and retained Sentinel quicklook bytes. Current counts and original-byte totals are reported by the database overview.
- `flight_import_runs` and `flight_observations`: exact, deduplicated receiver fixes retained for the incident lifetime.

The repository contains no data snapshots, raw-response directory or local refresh daemon. Reviewed incident configuration and all former local snapshots were seeded into Postgres before their local removal.

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
| adsb.fi + ADSB.lol + Airplanes.live | Exact receiver observations for the configured incident aircraft inside 10 km; providers are health-reported independently | 5 min |
| Open-Meteo | Hourly model-grid temperature, humidity, wind and gust rows | 5 min |
| Governor of Liège + BRF | Strictly parsed, timestamped affected-area reports and official incident events | 5 min |
| Stavelot + Malmedy + Jalhay + Baelen + Eupen + Waimes + Bütgenbach + VHP + HLZ DG + Eifel Police | Official local-authority and emergency-service RSS/JSON/WordPress/HTML feeds; incident notices and raw source responses are retained | 5 min |
| Vedia JSON:API | Incident-filtered article metadata, source summaries, revision timestamps and raw API audit artifacts, always labelled local media | 5 min |
| BE-Alert CAP gateway | CAP alerts accumulated from the live feed, including records retained after expiry | 5 min |
| Walloon DATEX II adapter | Contract-gated road incidents, congestion, works and closures by credentialed pull or authenticated push | 5 min |
| Official-perimeter adapter | Agency GeoJSON perimeter snapshots by credentialed pull or authenticated push | 5 min |
| Public-operations adapter | Sanitized dispatch, water pickup/drop, closure, evacuation and aggregate-compliance events | 5 min |
| RMI Mont Rigi WFS | Ten-minute station temperature, humidity, precipitation, wind, gust and validation flags | 10 min |
| DWD CDC | Ten-minute wind observations and quality level from three nearby stations | 10 min |
| NASA FIRMS, four sensors | Exact VIIRS Suomi-NPP, VIIRS NOAA-20, VIIRS NOAA-21 and MODIS thermal detections | 15 min |
| Copernicus EMS | Rapid Mapping activation catalogue and any incident match details | 60 min |
| Copernicus Data Space | Sentinel-2 L2A catalogue metadata and public JPEG quicklook pixels archived as Postgres artifacts | 60 min |
| Copernicus EFFIS WFS | Daily algorithmic VIIRS geometry nearest the incident | 6 h |

FIRMS is checked by every scheduler run, but its provider lease is 15 minutes to conserve the limited NASA MAP_KEY allowance. Each successful poll merges exact detections into retained history instead of replacing the previous window. Configure `FIRMS_MAP_KEY` as a sensitive Vercel production environment variable; the value is never returned to the browser or stored in a dataset.

The project is currently on Vercel Hobby, whose native cron frequency is not sufficient for five-minute work. A Vercel Queue message therefore wakes the private consumer at minute 02/07/12/... and schedules the next delayed message before polling providers. Queue delivery is durable and automatically retried. Push delivery is pinned to a deployment; the `refresh-scheduler` database record names the active deployment so an old chain stops after a release. `.github/workflows/refresh.yml` calls the public bootstrap endpoint on deployments and every 15 minutes as a fallback. Push runs wait until the production alias reports their exact commit before taking ownership. A once-daily native Vercel cron provides an additional recovery path allowed by Hobby. Every path activates the current deployment and schedules its next queue wake-up. The endpoint has no user-controlled URL or query target, and Postgres leases enforce the provider limits even if paths fire together.

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

- `DATABASE_URL` or `POSTGRES_URL`
- `FIRMS_MAP_KEY`

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
- FIRMS pixels are thermal anomalies, not a burned-area perimeter. Independent sensors are never summed or averaged, and MODIS does not receive a hectare estimate at this incident scale.
- EFFIS is a daily algorithmic VIIRS geometry, not a field-surveyed operational perimeter or within-day progression.
- Aircraft markers represent exact receiver observations within the preceding five minutes. Coverage gaps remain gaps; no route, water pickup or drop is inferred.
- RMI and DWD station values remain separate from the Open-Meteo model. Near-real-time quality-control status is retained.
- Copernicus EMS is a discovery catalogue. No EMS match means no matching activation was found in the current catalogue, not that operational mapping does not exist elsewhere. Sentinel-2 records include catalogue metadata and retained public JPEG quicklooks; they are not analysis-ready multispectral bands or a derived burn product.
- Municipal notices can report closures and evacuation guidance, but no agency feed is currently connected for a field-confirmed perimeter/fireline progression, live DATEX road state, suppression-resource dispatch, water pickup/drop events or aggregate evacuation compliance. Ready adapters remain empty until access or an agency-approved export is supplied. Raw CAD/radio and personal identities are intentionally excluded.
- This viewer is informational, not an emergency service. Follow BE-Alert and local authorities.
