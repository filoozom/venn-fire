# Venn Fire Watch

An evidence-first, time-based incident viewer for the 14 August 2026 fire near Drossart, Baelen, Belgium.

## What is included

- A map anchored at the reported Drossart locality (`50.54762° N, 6.05757° E`), not a guessed ignition coordinate.
- A five-minute timeline from 14 August 13:00 through 15 August 02:00 CEST.
- The cited `~100 ha` estimate only from its reporting time onward. No shape is generated from that number.
- The official Copernicus EFFIS near-real-time VIIRS-derived polygon for 14 August is bundled as a separate static reference footprint. Its geometry measures approximately `501 ha` locally. EFFIS generates this product automatically from 375 m active-fire detections; it is not a field-surveyed incident perimeter, is not used by EFFIS for burned-area statistics, and has no within-day timestamps for five-minute progression.
- Twenty-one exact Airplanes.live MLAT fixes for Belgian Federal Police helicopter G10 (`44c1e5`) in the broad incident area. Dashed straight connectors appear only between consecutive fixes at most two minutes apart and implying at most 160 knots; gaps remain open and the result is never presented as a continuous route or airborne status.
- Photo identification of both reported helicopters: a BRF incident image visibly shows G10 airborne at 15:37:08 CEST, and another visibly shows G12 landed at 16:30:54 CEST. The times come from intact image EXIF. The G12 map marker uses the photographer's embedded GPS position and is labelled as a photo location, not an aircraft fix.
- An optional census of every other transponder identifier observed within 5 km of Drossart in either of two retained receiver replays. It contains 116 identifiers and 1,372 exact source fixes within a 10 km context radius. Seven identifiers met a broad low-altitude review threshold; 109 were high-altitude overflights. No traffic entry is labelled as an incident aircraft.
- Hourly Open-Meteo wind, gust, temperature and humidity model values for the Drossart grid point (`50.548° N, 6.061° E`). Five-minute frames retain the applicable hourly source value.
- No placeholder FIRMS hotspots. VIIRS detections appear only after NASA returns data for a user-supplied `MAP_KEY`.
- Static GeoJSON/CSV import for additional tracks. Untimed imports are explicitly static and do not create aircraft status.

The map intentionally leaves unavailable data blank. BRF reports two Federal Police helicopters on scene with Bambi Buckets; visible markings in its timestamped incident photos identify them as G10 and G12. Only G10 has receiver positions near the incident. This is strong corroboration, but it is not an official mission log and no water-drop coordinates are inferred.

## Run locally

```bash
pnpm install
pnpm dev
```

Create a production bundle with:

```bash
pnpm build
```

## Copernicus EFFIS footprint import

Refresh the official near-real-time VIIRS-derived polygon for the incident date with:

```bash
pnpm import:effis
```

The importer queries the EFFIS WFS, retains the closest feature within 10 km of Drossart, calculates its geometry area and writes the source response, selected GeoJSON and manifest beneath `.local-data/effis/2026-08-14/`. Those audit files are ignored by Git. A reviewed snapshot of feature `effis.nrt.ba.poly.15626430` is bundled in the application; updating the local import does not silently replace production data.

## One-time FlightAware import

The local AeroAPI importer queries only the evidence-backed candidate registrations `OO-POE` (G10) and `OO-POH` (G12). It requests recent flight records first, then retrieves at most six observed tracks. Projected and virtual positions are discarded, gaps longer than ten minutes are not joined, and the five-minute export never interpolates coordinates.

Preview the requests and hard cost cap without contacting FlightAware:

```bash
pnpm import:flightaware -- --dry-run
```

Run it with an ephemeral key so the key is not written to the repository:

```bash
read -rsp 'FlightAware API key: ' FLIGHTAWARE_API_KEY && echo
export FLIGHTAWARE_API_KEY
pnpm import:flightaware
unset FLIGHTAWARE_API_KEY
```

The importer checks current-month AeroAPI usage and aborts if its maximum `$0.082` request budget could exceed the Personal plan's `$5` allowance. The 15 August one-time query returned no matching recent-flight records for either registration, so AeroAPI supplied no track positions. Results are stored beneath `.local-data/flightaware/2026-08-14/` and ignored by Git. Raw responses must be deleted by the date in `manifest.json`.

## Airplanes.live historical import and area scan

Fetch and normalize the daily traces for all seven known Belgian Federal Police MD helicopters (G10, G11, G12, G14, G15, G16 and G17):

```bash
pnpm import:public-adsb
```

This creates raw trace evidence, every source observation as GeoJSON, a non-interpolated five-minute CSV, and plausible line segments beneath `.local-data/airplanes-live/2026-08-14/`. Gaps over two minutes and jumps implying more than 160 knots split a segment. Five-minute buckets select an actual medoid observation rather than inventing a coordinate.

Run the same seven-aircraft audit against ADSB.lol's separate public globe archive:

```bash
pnpm import:public-adsb -- \
  --sourceRoot https://adsb.lol/globe_history \
  --output .local-data/adsb-lol/2026-08-14
```

To discover aircraft without starting from a callsign, scan the 30-minute replay tiles covering 11:00–22:00 UTC, then enrich every low-altitude candidate:

```bash
pnpm scan:aircraft -- \
  --date 2026-08-14 \
  --firstChunk 22 \
  --lastChunk 43 \
  --minLat 50.47 \
  --maxLat 50.70 \
  --minLon 5.90 \
  --maxLon 6.25

pnpm enrich:aircraft
```

The candidate-enrichment step accepts `--input`, `--output`, `--sourceRoot` and `--date`, so the same low-altitude review can be repeated against another tar1090 archive.

The scan downloads roughly 350 MB of replay tiles but retains only in-bounds observations. Its one-time result contained 299 transponder identifiers and 1,408 in-bounds observations. Sixteen aircraft met the deliberately broad low-altitude review threshold. G10 was the only helicopter observed within 5 km of Drossart. Two frequently observed Cessna 208s, OO-SPA and F-HSVS, are parachuting aircraft and are not classified as firefighting aircraft.

The ADSB.lol cross-check retained 2,868 in-bounds observations from 304 identifiers. It published daily trace files for G10 and G12 only, but neither trace contained an incident-area position; the other five known police helicopter hexes returned no daily trace. Its nine low-altitude area candidates resolve to fixed-wing aircraft except private EC120 OO-STX, whose only area observation was about 17 km from Drossart. The second incident helicopter is therefore identified as G12 from photography, not from a receiver track.

Airplanes.live's free interface is documented for non-commercial use. Confirm permission before republishing raw data in another context, retain attribution, and do not treat coverage as complete.

## Nearby receiver-traffic snapshot

Build the optional all-traffic layer from the two retained scans with:

```bash
pnpm build:traffic-snapshot
```

Independently compare the generated snapshot against both retained source documents with:

```bash
pnpm verify:traffic-snapshot
```

The verifier recomputes the selected identifier union and confirms that every published timestamp, coordinate and altitude exactly matches a retained provider observation. It also checks the selected geometry source, altitude classification and aggregate counts. The ignored `.local-data` source documents must be present to run either command.

The selection contains every identifier seen within 5 km of the Drossart locality by Airplanes.live or ADSB.lol between 11:00 and 22:00 UTC. G10 is then excluded because its incident representation is maintained separately. The resulting optional layer contains 116 other identifiers; 107 were independently observed inside the selection radius by both provider replays. For each identifier, the provider with more observations inside a 10 km context radius supplies the displayed geometry, avoiding duplicate or averaged positions.

The seven low-altitude review entries are Cessna 208s OO-SPA and F-HSVS, Diamond DA20 D-ELZB, Cessna 150s OO-ALD and OO-FUN, Cessna 152 OO-APV, and unidentified hex `449932` with observed callsign `OOFIR`. The Cessna 208s are known parachuting aircraft. None has a sourced firefighting role. “Low altitude” means only that at least one retained observation was at or below 5,000 ft.

Map points are exact observations and are never interpolated. Straight connectors are drawn only between adjacent fixes no more than 90 seconds apart and with an implied speed no greater than 250 knots for low-level traffic or 700 knots for high-altitude traffic. All other gaps stay open. A marker appears only when a source fix exists within the preceding five minutes; it does not assert that the aircraft remained airborne. The layer is off by default because most entries are unrelated overflights.

## Other public providers tested

- **adsb.fi:** live hex queries for `44c1e5` and `44c1e8` returned no current aircraft, as expected after landing. Its historical globe was reachable in a normal browser but the automated history-file requests were blocked by Cloudflare, so no historical coordinates were taken from adsb.fi.
- **OpenSky:** anonymous point-in-time track requests at timestamps independently observed by Airplanes.live returned no track; anonymous historical flight requests returned an access-denied response. Authenticated REST access may differ, while full Trino history is generally restricted to eligible research, government and aviation-authority use.
- **FlightAware AeroAPI:** the registration queries completed but returned no matching recent flights for the incident window.

No provider failure is interpreted as proof that an aircraft did not fly. It means only that the tested access path supplied no publishable observation.

## Data accuracy rules

- No fabricated aircraft, water drops, thermal detections, perimeter vertices or intermediate hectare estimates.
- An aircraft icon means “observed within the previous five minutes,” never “known to still be airborne.”
- MLAT is receiver-derived and may contain outliers. Exact observation points remain auditable; coverage gaps remain gaps.
- NASA FIRMS detections are thermal anomalies, not burned-area polygons.
- The EFFIS footprint is a daily VIIRS-derived algorithmic polygon, not NASA FIRMS point data, not an operational perimeter and not synchronized to the slider.
- The `~100 ha` value is a cited report, not a satellite measurement.
- Raw provider responses, retrieval timestamps and interpretation limits stay with every local import.
- This viewer is informational, not an emergency service. Follow BE-Alert and local authorities.

## Primary sources

- [Airplanes.live API](https://airplanes.live/api/)
- [Airplanes.live data-field descriptions](https://airplanes.live/rest-api-adsb-data-field-descriptions/)
- [ADSB.lol historical-data documentation](https://www.adsb.lol/docs/open-data/historical/)
- [Belgian Federal Police air support](https://www.police.be/5998/fr/a-propos/police-federale/police-administrative/appui-aerien)
- [BRF incident report](https://brf.be/regional/2099996/)
- [Vedia incident report](https://www.vedia.be/info/incendie-dans-les-fagnes-de-100-hectares-detruits-la-phase-provinciale-declenchee/213726)
- [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/)
- [Copernicus EFFIS rapid damage assessment](https://forest-fire.emergency.copernicus.eu/about-effis/technical-background/rapid-damage-assessment)
- [Copernicus EFFIS data and services](https://forest-fire.emergency.copernicus.eu/applications/data-and-services)
- [Open-Meteo](https://open-meteo.com/)
- [adsb.fi API documentation](https://github.com/adsbfi/opendata)
- [OpenSky data access](https://opensky-network.org/data/)

## Deployment

Production is hosted at [venn-fire.vercel.app](https://venn-fire.vercel.app).

Vercel deploys `main` automatically with `pnpm build`, output directory `dist`, and Node.js 22. Pull requests receive preview deployments.
