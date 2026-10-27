# Venn Fire Watch

Five-minute incident viewer for the High Fens wildfire near Drossart. The self-hosted production site is [venn.apyos.com](https://venn.apyos.com).

## WMS overlays

The self-hosted Node server exposes **`/wms`**, using the same retained PostgreSQL data and time-selection calculations as the viewer. Rebuilding and restarting the existing app container publishes the route; no database migration, GIS server or extra service is required. Add `https://venn.apyos.com/wms` as a WMS connection in a GIS client, then read `GetCapabilities` to discover the layers and temporal dimension:

```text
https://venn.apyos.com/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities
```

The capabilities organize the resources into **Fire extent and change**, **Thermal detections**, **Satellite imagery**, **Weather**, **Air quality models**, **Aircraft** and **Reference**. Thermal detections contain a subgroup for each FIRMS sensor, with all-confidence and individual confidence layers. These title-only groups organize the client layer tree; requestable layer names and dated service URLs remain unchanged. Refresh the WMS connection to load the hierarchy.

Each map resource is independently selectable with `LAYERS`:

| Layer name | Content |
| --- | --- |
| `best_estimate` | Black retained footprint and red recent evidence, using the viewer's 30-day / 24-hour rules |
| `effis_activity` | EFFIS daily activity envelope |
| `firms_viirs_snpp`, `firms_viirs_noaa20`, `firms_viirs_noaa21`, `firms_modis`, `firms_meteosat` | Individual FIRMS sensors; parent layers include all confidence levels |
| Each FIRMS name plus `_high`, `_nominal` or `_low` | Independent confidence subsets; combine these instead of their parent to avoid drawing the same observations twice |
| `sentinel2_change`, `sentinel3_frp` | Sentinel-2 observed change and Sentinel-3 coordinate measurements; the latter is empty while measurements are unavailable |
| `precipitation` | Retained RMI/DWD radar, using the same provider selection as the viewer |
| `gibs_true_color`, `gibs_false_color` | Daily NASA VIIRS imagery |
| `cams_pm25`, `cams_wildfire_pm10` | Regional CAMS forecasts; wildfire PM10 is experimental |
| `aircraft` | Exact incident-aircraft fixes, fading routes and last observed positions |
| `wind_model`, `wind_mont_rigi`, `wind_dwd_<station-id>` | Independent model/station wind layers; actual station IDs are listed in capabilities |
| `protected_area` | Static indicative reserve extent |

For example, retrieve a historical transparent overlay with two layers:

```bash
curl --fail --get 'https://venn.apyos.com/wms' \
  --data-urlencode 'SERVICE=WMS' --data-urlencode 'VERSION=1.3.0' \
  --data-urlencode 'REQUEST=GetMap' \
  --data-urlencode 'LAYERS=best_estimate,aircraft' --data-urlencode 'STYLES=,' \
  --data-urlencode 'TIME=2026-08-17T12:00:00Z' \
  --data-urlencode 'CRS=CRS:84' --data-urlencode 'BBOX=5.975,50.49,6.145,50.575' \
  --data-urlencode 'WIDTH=1024' --data-urlencode 'HEIGHT=512' \
  --data-urlencode 'FORMAT=image/png' --data-urlencode 'TRANSPARENT=TRUE' \
  --output fire-overlay.png
```

`TIME` selects one advertised five-minute map state in UTC. Omit it or use `current` for the latest timeline frame. Hourly and daily snapshots use the same endpoint with requests spaced by an hour or day. All temporal layers advertise the map timeline, including transparent states when evidence is missing or expired; daily imagery and irregular satellite acquisitions keep their original observation times and fade rules. Full timestamps are required: date-only values, ranges, lists and off-grid times return `InvalidDimensionValue`. No later observation is substituted for an earlier request. `X-WMS-Time` reports the selected time.

### WalOnMap

In [WalOnMap](https://geoportail.wallonie.be/carte), open **Données → Ajouter des données → Autres options → Depuis l'URL d'un service**. Choose **WMS**, enter a service URL with the desired UTC time, then click **Charger**. Click **Tout sélectionner / déselectionner** to clear the initial selection, select **Best estimate outline**, then click **Ajouter**:

```text
https://venn.apyos.com/wms?TIME=2026-08-17T12:00:00Z
```

Zoom to Drossart in the High Fens (approximately 50.548° N, 6.058° E). The capabilities preserve the URL's `TIME` for WalOnMap's map requests; change the timestamp and add the service again to choose another snapshot. Its background-map time-travel control does not select this WMS layer's date. Without `TIME`, the service shows the latest frame, so August fire evidence can be completely transparent by October under the normal fade rules. All currently advertised layers can be requested together. Selecting everything draws each FIRMS sensor together with its confidence subsets, and overlapping imagery can cover lower layers; selecting only the layers you need is usually clearer.

A successful transparent image can mean no data at the selected time or location. At `2026-08-17T12:00:00Z`, CAMS is empty because retained forecasts start at 17:00 UTC; Sentinel-3 FRP has no retained coordinate measurements; the configured protected-area geometry is empty; and some sensor/confidence subsets have no observations within their fade window. Radar can also be transparent when no precipitation is detected. Wind station markers appear at their station locations, which can be outside a close-up of the fire. These cases do not justify substituting later observations for the requested time.

Historical maps are **reconstructions using currently retained evidence**, rather than immutable reproductions of an old website publication. Backfills and corrections may change an old frame. CAMS selects the newest retained forecast cycle covering the requested valid time. Dataset hashes and rendering-code hashes invalidate cached images after data or calculation/style changes. The in-process data snapshot can lag the database by up to one minute; browser responses revalidate with ETags.

The supported operations are `GetCapabilities` and `GetMap`, version **1.3.0**, with `image/png` output. `CRS:84` uses longitude/latitude BBOX order; `EPSG:4326` uses latitude/longitude; `EPSG:3857`, Belgian Lambert 72 (`EPSG:31370`) and Belgian Lambert 2008 (`EPSG:3812`, used by WalOnMap) use easting/northing metres. Raster pixels are reprojected from their retained projection, including RMI's Mercator animation; nearest-neighbour sampling preserves categorical radar colours. Source crops bound the available imagery. Layer order follows `LAYERS`, first at the bottom. Styles are empty/default; `TRANSPARENT=FALSE` and `BGCOLOR=0xRRGGBB` support opaque output.

Requests are limited to 2,048 pixels per side, 4,194,304 pixels total and 64 layers. The full advertised 2,048 × 2,048 tile size is supported, including WalOnMap's tiled requests on large displays. Two distinct renders may run concurrently and six more may wait for a slot; further work returns a retryable 503. Abandoned tiles are removed from the queue and active renders stop when no clients still need them, so panning does not leave obsolete tiles blocking the new view. Completed PNGs share a 32 MiB memory cache and identical concurrent requests share one render, including queued requests. Invalid requests return WMS XML exceptions. Missing archived images return an error rather than a misleading blank observation. Requests never fetch providers or accept arbitrary image/style URLs.

Raster reprojection runs in workers so both render slots can use separate CPU cores while HTTP requests remain responsive. Projected raster layers share a separate 64 MiB PNG cache keyed by source image bytes, crop, projection, output geometry and opacity. Layer selections and unrelated dataset refreshes reuse unchanged rasters; changed image bytes or visual inputs invalidate them. Weather and best-estimate calculations are reused across selections for the same retained-data bundle and timestamp; a new bundle invalidates that geometry cache.

This service publishes rendered overlays. It does not include third-party basemaps, browser-local imported tracks, measurement drawings, feature downloads, `GetFeatureInfo` or custom styling. Source attribution and data terms still apply. Run `pnpm verify:wms` for fixture-based rendering, time, projection, caching and concurrency checks; it writes an example PNG and capabilities XML to `/tmp`. The current implementation has not been OGC-certified.

## Data architecture

The browser is database-only. It paints the viewer shell immediately, loads `/api/data?scope=core`, and renders the incident before asynchronously loading the larger retained aircraft projection from `/api/data?scope=aircraft`. It repeats both reads every five minutes with `cache: 'no-store'`; it never contacts a provider and has no bundled JSON fallback. The unscoped route remains the complete compatibility response. `/api/data` supports ETag revalidation and a short shared-cache lifetime; content-addressed images are immutable, and the other read APIs emit `no-store` headers.

The production flow is:

```text
Local Node server timer (every 5 min, at minute 02/07/12/...)
  → per-source Postgres lease
  → fixed upstream provider
  → current dataset + historical version + refresh-run record
  → /api/data
  → five-minute browser timeline
```

The PostgreSQL database is addressed through `DATABASE_URL`/`POSTGRES_URL` or the certificate-verified `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PG_CA_PEM` and `PGSSL_SERVERNAME` parameter form. The latter takes precedence when `PG_CA_PEM` is present. The runtime uses the standard PostgreSQL protocol, SCRAM channel binding and a process-wide connection pool, and works with a TLS-enabled self-hosted server, PgBouncer endpoint or managed provider. Tables are created idempotently on server startup:

- `app_datasets`: latest normalized payload for each dataset.
- `app_dataset_versions`: immutable, content-addressed history when source content changes. Retrieval timestamps are excluded from the content hash.
- `app_public_datasets`: compact current projections for the viewer. Canonical rows remain complete; repeated aircraft provider strings and reproducible FIRMS footprint coordinates are omitted only from this delivery copy to reduce database transfer.
- `source_refresh_runs`: one status record for every claimed source/time bucket, including unchanged polls and errors.
- `source_artifacts`: the content-addressed raw audit archive, including source API/feed responses, retained Sentinel quicklook bytes, exact clipped Sentinel multispectral arrays, decoded RMI radar frames, NASA GIBS crops and CAMS forecast images/point responses. Current counts and original-byte totals are reported by the database overview.
- `flight_import_runs` and `flight_observations`: exact, deduplicated receiver fixes retained for the incident lifetime.

The repository contains no data snapshots, raw-response directory or separate refresh daemon. The deleted aircraft snapshot is recovered once from its immutable Git revision, validated as 51 exact observations, archived and idempotently inserted into Postgres. The five timestamped area rows from the same pre-database revision are likewise checksum-validated and migrated once, which protects historical report steps that changed on their live article pages before the database cutover. Migration records prevent repeat upstream requests after either succeeds.

### Retained public-alert lookup

`/api/live-reports` returns the accumulated affected-area reports and BE-Alert CAP records, including alerts that have expired and disappeared from the live feed. Its optional `q` parameter searches the retained title, description, headline and area fields without changing the source data:

```bash
curl -fsSL 'https://venn.apyos.com/api/live-reports?q=Ovifat' \
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
| adsb.fi + ADSB.lol | One geographic point request per provider; verified aircraft, `GRZLY##` callsigns and candidates with response-aircraft type, description, rotorcraft category or military metadata are selected inside 10 km, with exact receiver observations and every complete raw response retained | 5 min |
| Retained aircraft poll recovery | No provider request: reprocesses the newest two hours of archived point responses and walks a resumable six-hour historical window backward, recovering candidates with response-aircraft evidence | 5 min |
| ADSB.lol current traces | Complete available current-day route sessions for every recently retained incident aircraft—including G10, G12, G17 and GRZLY aircraft—refreshed without interpolation after that session has entered the incident area | 5 min |
| Airplanes.live + ADSB.lol completed traces | Previous-day full-trace reconciliation; only sessions that entered the incident area are accepted, then their complete provider-supported routes and raw trace files are retained | 6 h |
| Completed aircraft route recovery | One completed incident day per run, resumably backfilling complete incident-connected route sessions only for aircraft already qualified near the fire; completion fingerprints prevent repeated calls | 5 min while pending |
| Airplanes.live live API | Access-health check retained while the provider rejects server traffic, without consuming its limited allowance on repeated HTTP 403 responses | 60 min |
| Open-Meteo | Hourly model-grid temperature, feels-like temperature, humidity, precipitation probability/amount, weather code, cloud, visibility, wind and gust rows; recent overlap and at least the next 48 hours are retained | 5 min |
| Governor of Liège + BRF | Strictly parsed affected-area reports and official incident events; stated effective time and bulletin publication time are retained separately | 5 min |
| Stavelot + Malmedy + Jalhay + Baelen + Eupen + Waimes + Bütgenbach + VHP + HLZ DG + Eifel Police | Official local-authority and emergency-service RSS/JSON/WordPress/HTML feeds; incident notices and raw source responses are retained | 5 min |
| Vedia JSON:API | Incident-filtered article metadata, source summaries, revision timestamps and raw API audit artifacts, always labelled local media | 5 min |
| BE-Alert CAP gateway | CAP alerts accumulated from the live feed, including records retained after expiry | 5 min |
| RMI Mont Rigi WFS | Ten-minute station temperature, humidity, precipitation, wind, gust and validation flags | 10 min |
| RMI public precipitation-radar animation | Official compressed categorical radar frames decoded server-side, stored as time-aligned transparent PNG overlays together with every original animation payload | 5 min check; public images currently 10 min |
| DWD RADOLAN YW daily archive | Official 1 km, five-minute precipitation amounts from the ignition onward; each available compressed daily archive and every incident-area display frame are retained in PostgreSQL | 5 min publication check; 5 min observations |
| DWD CDC | Ten-minute wind observations and quality level from three nearby stations | 10 min |
| NASA FIRMS, five products | Exact VIIRS Suomi-NPP, VIIRS NOAA-20 and VIIRS NOAA-21 footprints, MODIS detections, plus GOES_NRT Meteosat detections with approximate viewing-geometry ground footprints | 15 min |
| NASA GIBS | Incident-area VIIRS true-colour and M11/I2/I1 short-wave-infrared daily imagery; distinct same-day revisions and historical incident dates are retained | 30 min check; daily product |
| NASA FIRMS ignition-day recovery | One official two-day API recovery for the missing 14 August window; completion marker prevents repeat allowance use | 6 h |
| Copernicus EMS | Rapid Mapping activation catalogue and any incident match details | 60 min |
| Copernicus Data Space + Earth Search public COGs | Sentinel-2 L2A catalogue metadata, public JPEG quicklooks, exact clipped B8A/B12/SCL arrays and cloud-masked dNBR geometry on the shared 50 m grid | 5 min catalogue check; raster processing once per new scene |
| Copernicus Sentinel-3 SLSTR NRT FRP STAC | Every incident-intersecting NRT FRP overpass plus retained public preview; the catalogue is public, while coordinate-level measurement assets require authenticated Copernicus data access that is not connected | 30 min |
| Copernicus Sentinel-1 GRD STAC | Incident-area IW acquisitions, selected retained previews and same-platform/same-relative-orbit pre/post pairs; catalogue previews never alter the Best estimate | 60 min |
| Copernicus CAMS via ECMWF WMS | Georeferenced 0.1° wildfire-only PM10 and PM2.5 ensemble forecast images plus exact incident-grid values and raw feature responses, retained by coherent daily forecast cycle; wildfire PM10 is explicitly labelled experimental | 60 min |
| Copernicus EFFIS WFS | Daily algorithmic VIIRS geometry nearest the incident | 6 h |
| Copernicus EFFIS historical-day recovery | Checksum-validated one-time recovery of the two pre-database daily products from the immutable project revision | 6 h |

FIRMS is checked by every scheduler run, but its provider lease is 15 minutes to conserve the limited NASA MAP_KEY allowance. Each successful poll merges exact detections into retained history instead of replacing the previous window and archives five raw product CSV responses in Postgres. The dataset reports both `generatedAt` (when FIRMS was queried) and `latestAcquiredAt` (the newest satellite scan or overpass returned), so a current successful poll is distinguishable from a new heat observation. Raw polar footprints fade linearly and leave the current map after 24 hours; the coarse instantaneous Meteosat product uses a 15-minute window. Historical rows remain in PostgreSQL and remain available on their original timeline frames. The separate Best estimate can still use qualifying retained evidence inside its documented 30-day window. Corroboration is recalculated only from observations available by the selected timeline time, preventing later satellite observations from leaking backward. GOES_NRT is capped to a two-day request and returns Met12/Met10/Met9 over Belgium. Its `scan`/`track` columns are not physical kilometre dimensions: Met12 supplies zeroes while the MSG rows carry image-grid coordinates. The raw values are retained for provenance and ignored for footprint sizing. The map instead computes an explicitly approximate local ground footprint from the spacecraft generation, its EUMETSAT service longitude during this incident and the viewing geometry. Met12 and Met10 are at 0°; Met9 is at 45.5°E and therefore has a much larger, rotated footprint here. These rectangles communicate detection uncertainty and are never used for hectares. Configure `FIRMS_MAP_KEY` in the app container environment; stored request URLs replace it with `MAP_KEY`, and the secret is never returned to the browser or written to the database.

The environmental additions remain evidence-specific. The precipitation layer combines RMI's retained live categorical frames with DWD's five-minute, 1 km RADOLAN YW history; the provider and measurement are shown per frame. NASA GIBS is visual imagery, and CAMS is a 0.1° model forecast; none can silently become a fire perimeter. ECMWF replaces overlapping valid hours when a new daily CAMS cycle is published, so the ingest records the cycle timestamp and re-fetches that cycle's already elapsed UTC hours atomically instead of joining two forecast revisions. Superseded images remain archived. CAMS rasters are retained over a regional crop and feathered at the display edge instead of presenting the crop rectangle as a plume boundary. Its published colour style saturates at 500 µg/m³, while exact provider point values remain separately displayed. Sentinel-3 catalogue intersections do not establish a hotspot: the currently connected public feed supplies pass metadata and previews, while its coordinate-level FRP measurement assets require authenticated Copernicus data access. Sentinel-1 acquisitions are paired only across the same spacecraft, relative orbit and direction, and their public catalogue previews remain visual context rather than a change measurement. All source imagery is served from PostgreSQL through `/api/source-image` with no-store headers; the browser never requests the upstream provider or receives raw binary payloads.

Aircraft discovery does not add provider calls: the former fixed-hex request is replaced by one point request covering the incident. Exact Mode-S identities already verified for the incident remain accepted even when no callsign is broadcast, as are explicit `GRZLY##` callsigns. A previously unseen aircraft inside the radius is retained only when its type, description, rotorcraft category or military metadata supports a response-aircraft interpretation. Multiple receivers corroborate a position, not incident involvement, so proximity or repetition alone never promotes ordinary traffic. Candidates remain visibly labelled rather than asserted as confirmed missions. Archived polls are reprocessed without upstream calls so response aircraft missed by the old allow-list can be recovered. Once accepted, an identity is retained in Postgres and included in recent current-trace reconciliation. A trace session is attached only if it actually enters the incident radius, after which that complete available session is retained from its first to last receiver-supported fix; separate same-day sessions elsewhere are not attached. Exact source traces remain in Postgres while the browser receives one exact fix per aircraft per ten-second bucket for responsive rendering. Inactive identities are no longer queried forever. Other nearby traffic remains only in the raw provider artifact. OOVST/OO-VST and the QTR8098 Boeing 777 transit are explicit reviewed exclusions and remain available only in retained raw audit data.

The Best estimate remains one 50 m evidence union and one matching area figure, but its age is now visible. Qualifying ground observed during the previous 30 days is black; qualifying thermal or aircraft-supported evidence from the previous 24 hours is overlaid in red. Sentinel-2 dNBR can support the black burned footprint but never claims current heat. The 30-day cutoff is a display heuristic, not a pixel-level measurement of regrowth, and an absence of red is not proof that the fire is out. The thermal core starts with high-confidence, independently corroborated VIIRS observations available by the selected time. At most one high-confidence Terra/Aqua pass inside the 30-day window may extend the union when its pixels lie within 500 m of the core or aircraft-supported edge; retaining only the newest qualifying pass prevents successive 1 km snapshots from accumulating into an inflated scar. Aircraft support is not a separate outline: repeated sharp `GRZLY##` direction changes must be within 1 km of the thermal edge and within 900 m of another five-minute evidence frame. Each disconnected local cluster bounds its own smallest lobe against the thermal outline. It is red for 24 hours after its latest qualifying observation and then remains black until the 30-day cutoff. Approach, reservoir and disconnected route legs are excluded. Receiver data has no payload or drop-state field, so this remains a conservative inference rather than proof of a water drop or confirmed fire front. The separate touched-zone boundary remains removed.

The local refresh worker fetches Bütgenbach's official sitemap and article pages directly, validates article URLs against the provider's trusted host, and archives the responses in Postgres.

The Node server refreshes sources at minute 02/07/12/... of each hour. Per-source Postgres leases enforce provider limits and prevent overlapping operator runs from multiplying requests. To refresh manually, run `docker compose exec app node scripts/refresh-once.mjs` on the host.

## Local development

```bash
pnpm install
pnpm dev
```

Run the API server on port 3000 with `pnpm start` and database credentials, or use the Docker stack. Vite proxies `/api/data`, `/api/source-image` and `/api/sentinel-quicklook` to `http://127.0.0.1:3000` by default. To use the running production API instead:

```bash
VENN_FIRE_DEV_DATA_ORIGIN=https://venn.apyos.com pnpm dev
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
pnpm visual-check https://venn.apyos.com
pnpm verify:timeline https://venn.apyos.com
```

## Deployment

Production runs on this host with Docker Compose and Traefik. From `/srv/fire`, rebuild and restart only the app:

```bash
docker compose -f docker-compose.yaml -f docker-compose.public.yaml up -d --build --no-deps app
```

The host Compose files use `./app` as their build context and connect to the existing TLS-enabled PostgreSQL service. `REFRESH_ENABLED=true` enables the local five-minute refresh loop. A push to GitHub runs CI; deployment is performed on the host.

Required production variables:

- `DATABASE_URL`/`POSTGRES_URL`, or `PGHOST` + `PGPASSWORD` + `PG_CA_PEM` (with optional `PGPORT`, `PGUSER`, `PGDATABASE` and `PGSSL_SERVERNAME`); credentials and CA may also use `_FILE` paths for Docker secrets
- `FIRMS_MAP_KEY`

Fresh installations and the required incident-config seeding step are documented in [`docs/self-hosting-docker.md`](docs/self-hosting-docker.md). Database configuration and history/artifact copies are documented in [`docs/self-hosted-postgres.md`](docs/self-hosted-postgres.md).

The internal source-access and interpretation audit is in [`docs/known-source-limits.md`](docs/known-source-limits.md), and the retained raster format and selection rule are documented in [`docs/sentinel2-analysis.md`](docs/sentinel2-analysis.md). Internal limitations are deliberately excluded from the public viewer and its API payloads.

## Interpretation limits

- The five-minute timeline carries the latest sourced value forward; it never interpolates a new measurement.
- FIRMS pixels are thermal anomalies, not a burned-area perimeter. Raw polar footprints fade for 24 hours and Meteosat fades for 15 minutes, while all source history remains in PostgreSQL. Standalone per-sensor figures remain separate and MODIS/Meteosat receive no standalone area. The Best estimate unions its 30-day corroborated VIIRS core, at most one retained qualifying high-confidence MODIS pass, positive cloud-clear Sentinel-2 dNBR evidence anchored to that core, and compact repeat-supported aircraft lobes. Black shows that retained union; red shows only its thermal and aircraft-supported subset from the previous 24 hours. Meteosat never contributes.
- EFFIS is a daily algorithmic VIIRS geometry, not a field-surveyed operational perimeter or within-day progression. When successive daily queries return the same geometry, its age follows the first date of that unchanged run rather than the newest query date. The map fades it for 72 hours and then hides it; PostgreSQL history remains intact.
- Other time-sensitive context also ages visually: Sentinel-3 FRP for 24 hours, precipitation radar for 60 minutes, CAMS valid-time rasters for three hours, GIBS daily imagery for 72 hours, and Sentinel-2 observed change for 30 days. Expiry changes map visibility only, never database retention.
- Aircraft markers and gap-limited connectors represent exact receiver observations, fade linearly and disappear after 24 hours. Coverage gaps remain gaps; no route, water pickup or drop is inferred. Repeated near-core `GRZLY##` direction changes may extend the Best-estimate union under the repeat-support rule: the accepted lobe is red for 24 hours and then black until the 30-day retention cutoff, but it does not establish a confirmed perimeter.
- The ruler control measures straight-line map distance between clicked points and can continue across multiple segments. It is a visual planning aid, not a road distance or safety buffer.
- RMI and DWD station values remain separate from the Open-Meteo model. Near-real-time quality-control status is retained.
- Copernicus EMS is a discovery catalogue. No EMS match means no matching activation was found in the current catalogue, not that operational mapping does not exist elsewhere. Sentinel-2 contributes only positive, cloud-clear B8A/B12 dNBR change meeting the documented core-distance and connected-cell rule. Obscured or non-qualifying pixels remain unknown and never erase other evidence.
- This viewer is informational, not an emergency service. Follow BE-Alert and local authorities.
