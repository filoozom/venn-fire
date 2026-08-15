# Venn Fire Watch

An interactive, time-based fire situation dashboard for the High Fens around Eupen and Baelen, Belgium.

## What is included

- A real OpenStreetMap / satellite / topographic map with the incident anchored near Pilgerweg and Allgemeines Venn.
- A coordinated timeline that updates the reconstructed fire area, hotspot observations, aircraft positions, event log and wind field.
- Hourly wind, gust, temperature and humidity values seeded for `50.593° N, 6.194° E` in the `Europe/Brussels` timezone.
- Separate visual language for reported area, thermal anomaly points and a reconstructed perimeter.
- A data workspace for saving a NASA FIRMS `MAP_KEY`, querying the FIRMS area endpoint and replacing the reference hotspot layer with returned VIIRS detections.
- GeoJSON and CSV aircraft-track import. GeoJSON should contain `LineString` features; CSV should contain `latitude` and `longitude`, with an optional `callsign`, `flight` or `registration` column.
- Responsive desktop and mobile layouts, timeline playback and keyboard control (`←`, `→`, and space).

## Run locally

```bash
pnpm install
pnpm dev
```

Local development and production builds both run at `/`.

Create a production bundle with:

```bash
pnpm build
```

## Data accuracy

This repository is a working product prototype, not an emergency service.

- NASA FIRMS detections are thermal anomalies. A VIIRS marker represents an observation footprint of roughly 375 m; it is not an exact burned-area polygon.
- The `~100 ha` milestone is displayed as a reported estimate, not a satellite measurement.
- The progression geometry and the bundled aircraft paths are explicitly labelled as an incident reconstruction. Connect an official perimeter or import licensed historical aircraft tracks before treating them as an operational record.
- Historical ADS-B coverage is not complete. Low-level, emergency, military or non-transmitting aircraft may be missing.
- Production use should proxy credentialed APIs server-side and archive the raw observation, retrieval time and provenance for every displayed record.

For emergency information, follow BE-Alert and local authorities.

## Primary integrations

- [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/)
- [NASA FIRMS API and map key](https://firms.modaps.eosdis.nasa.gov/api/map_key/)
- [RMI Belgium open data](https://opendata.meteo.be/)
- [Open-Meteo historical weather](https://open-meteo.com/en/docs/historical-weather-api)
- [ADS-B Exchange data products](https://www.adsbexchange.com/data/)

## Deployment

Production is hosted at [venn-fire.vercel.app](https://venn-fire.vercel.app).

Vercel detects the Vite configuration automatically. The production settings are:

- Production branch: `main`
- Build command: `pnpm build`
- Build output directory: `dist`
- Node.js version: `22`

Connect `filoozom/venn-fire` in the Vercel project's Git settings to deploy every push to `main` automatically and create preview deployments for pull requests.
