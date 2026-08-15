# Venn Fire Watch

An evidence-first, time-based incident viewer for the 14 August 2026 fire near Drossart, Baelen, Belgium.

## What is included

- A map anchored at the reported Drossart locality (`50.54762° N, 6.05757° E`), not a guessed ignition coordinate.
- A five-minute timeline from 14 August 13:00 through a bundled 15 August 11:45 CEST fallback. On Vercel, `/api/live-situation` advances the clock and refreshes Open-Meteo plus live incident-aircraft observations every 60 seconds behind a CDN cache.
- A timestamped, stepwise reported-area series: `~60 ha` at 14 August 16:00, `~100 ha` at 20:00 and `~850 ha` at 15 August 07:00 from the Governor of Liège, then `>900 ha` at 11:28 from BRF. Between reports the UI means “last reported”; it never invents intermediate growth or a shape.
- Separate Copernicus EFFIS daily VIIRS-derived polygons for 14 and 15 August. Their locally calculated geometry areas are approximately `501 ha` and `4,857 ha`. The latter sharply conflicts with field reporting and is labelled as an algorithmic geometry, never as 4,857 burned hectares. EFFIS supplies no within-day acquisition timestamp, so the last daily product is carried forward until the next retrieved product replaces it.
- Thirty-two exact Airplanes.live MLAT fixes for Federal Police helicopter G10 (`44c1e5`): 21 from the audited 14 August daily trace and 11 from 15 August 30-second replay snapshots. Nineteen 15 August replay fixes are bundled for G17 (`44c1ea`). Dashed straight connectors appear only between consecutive fixes at most two minutes apart and implying at most 160 knots; every other gap stays open.
- Photo identification of both reported helicopters: a BRF incident image visibly shows G10 airborne at 15:37:08 CEST, and another visibly shows G12 landed at 16:30:54 CEST. The times come from intact image EXIF. The G12 map marker uses the photographer's embedded GPS position and is labelled as a photo location, not an aircraft fix.
- An optional census of every other transponder identifier observed within 5 km of Drossart in either of two retained receiver replays. It contains 116 identifiers and 1,372 exact source fixes within a 10 km context radius. Seven identifiers met a broad low-altitude review threshold; 109 were high-altitude overflights. No traffic entry is labelled as an incident aircraft.
- Hourly Open-Meteo wind, gust, temperature and humidity model values for the Drossart grid point (`50.548° N, 6.061° E`). Five-minute frames retain the applicable hourly source value.
- No placeholder FIRMS hotspots. VIIRS detections appear only after NASA returns data for a user-supplied `MAP_KEY`.
- Static GeoJSON/CSV import for additional tracks. Untimed imports are explicitly static and do not create aircraft status.

The 15 August G10/G17 replay is available from Airplanes.live only; ADSB.lol has no incident-area observations for either helicopter that day. It is therefore labelled single-provider evidence pending publication of the full daily traces. G12 remains supported near this incident by a timestamped 14 August photo, not receiver positions. None of this is an official mission log, and no water pickup or drop coordinates are inferred.

## Run locally

```bash
pnpm install
pnpm dev
```

Create a production bundle with:

```bash
pnpm build
```

With the dev server running, verify every report-time transition, EFFIS carry-forward/replacement and chart bound with:

```bash
pnpm verify:timeline -- http://127.0.0.1:5173
```

## Copernicus EFFIS footprint import

Refresh the official near-real-time VIIRS-derived polygon for a product date with:

```bash
pnpm import:effis -- --date 2026-08-15 --output .local-data/effis/2026-08-15
```

The importer queries the EFFIS WFS, retains the closest feature within 10 km of Drossart, calculates its geometry area and writes the source response, selected GeoJSON and manifest beneath the chosen `.local-data/effis/<date>/` directory. Those audit files are ignored by Git. Reviewed 14 and 15 August geometries are bundled in the application; updating a local import does not silently replace production data. The 15 August response contained geometry only and calculated to `4,857.041 ha`; because that conflicts with the official/reporting series, the viewer explicitly treats it as an overinclusive algorithmic geometry rather than affected-area truth.

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

The 15 August incident-aircraft snapshot comes from widened Airplanes.live replay scans through 09:30 UTC. Repeat the retained scan with:

```bash
pnpm scan:aircraft -- \
  --date 2026-08-15 \
  --firstChunk 0 \
  --lastChunk 18 \
  --minLat 50.35 \
  --maxLat 50.85 \
  --minLon 5.70 \
  --maxLon 6.70 \
  --output .local-data/airplanes-live/2026-08-15/area-scan-wide.json
```

The checked-in `src/incidentAircraftSnapshot.json` keeps only source observations within 10 km of Drossart. Verify every bundled G10/G17 timestamp, coordinate and altitude against the ignored 14/15 August source files with:

```bash
pnpm verify:incident-aircraft
```

The verifier currently confirms 21 G10 daily-trace fixes from 14 August plus 30 Airplanes.live replay observations on 15 August: 11 for G10 and 19 for G17. It also confirms that ADSB.lol retained zero G10/G17 observations in its 15 August replay. Connector auditing accepts 17 G10 and 5 G17 adjacent pairs; all pairs rejected for gaps or implied speed remain visually disconnected.

The scan downloads roughly 350 MB of replay tiles but retains only in-bounds observations. Its one-time result contained 299 transponder identifiers and 1,408 in-bounds observations. Sixteen aircraft met the deliberately broad low-altitude review threshold. G10 was the only helicopter observed within 5 km of Drossart. Two frequently observed Cessna 208s, OO-SPA and F-HSVS, are parachuting aircraft and are not classified as firefighting aircraft.

The ADSB.lol 14 August cross-check retained 2,868 in-bounds observations from 304 identifiers. It published daily trace files for G10 and G12 only, but neither trace contained an incident-area position; the other five known police helicopter hexes returned no daily trace. Its nine low-altitude area candidates resolve to fixed-wing aircraft except private EC120 OO-STX, whose only area observation was about 17 km from Drossart. On 15 August, Airplanes.live—but not ADSB.lol—observed both G10 and G17 over the incident area. G12 remains identified near this incident from photography, not a receiver track.

The widened scans also establish two useful negatives. No incident-area aircraft observations were retained from 22:00 to 24:00 UTC on 14 August, and no aircraft in the wider box was below 6,000 ft. Aircraft with callsigns associated with German operations stayed at least 23.5 km from Drossart and were working the separate Hürtgenwald fire; none is classified as Venn incident support. A repeated false MLAT cluster near Aachen/Walheim is outside the 10 km incident selection and is rejected; it must never be interpreted as a water pickup.

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

- No fabricated aircraft, water drops, thermal detections or perimeter vertices. The reported-area series never interpolates intermediate hectares; separately labelled, reproducible sensor-footprint estimates are allowed under the rule below.
- An aircraft icon means “observed within the previous five minutes,” never “known to still be airborne.”
- MLAT is receiver-derived and may contain outliers. Exact observation points remain auditable; coverage gaps remain gaps.
- NASA FIRMS detections are thermal anomalies, not burned-area polygons.
- A FIRMS-derived hectare estimate is permitted only as its own detection-footprint union layer with named sensors, acquisition times, source URL and exact method. It is never merged into official affected-area reports or described as confirmed burned hectares.
- EFFIS geometry is a daily VIIRS-derived algorithmic polygon, not NASA FIRMS point data, not an operational perimeter and not a within-day five-minute series. The last product is visibly carried forward until replacement.
- Reported fire size is a step series tied to four source times. Repeating the latest value between reports means “last reported,” not “measured continuously.”
- The 15 August `4,857 ha` EFFIS polygon calculation is not shown as burned area; the primary affected-area figure remains the dated ~850/>900 ha reporting.
- The Aachen/Walheim MLAT artifact and every observation outside 10 km are excluded from incident-aircraft data.
- Raw provider responses, retrieval timestamps and interpretation limits stay with every local import.
- This viewer is informational, not an emergency service. Follow BE-Alert and local authorities.

## Primary sources

- [Airplanes.live API](https://airplanes.live/api/)
- [Airplanes.live data-field descriptions](https://airplanes.live/rest-api-adsb-data-field-descriptions/)
- [ADSB.lol historical-data documentation](https://www.adsb.lol/docs/open-data/historical/)
- [Belgian Federal Police air support](https://www.police.be/5998/fr/a-propos/police-federale/police-administrative/appui-aerien)
- [Governor of Liège official incident updates](https://gouverneur.provincedeliege.be/fr/node/7923)
- [BRF 15 August situation report](https://brf.be/regional/2100196/)
- [BRF 14 August helicopter report](https://brf.be/regional/2099996/)
- [Vedia incident report](https://www.vedia.be/info/incendie-dans-les-fagnes-de-100-hectares-detruits-la-phase-provinciale-declenchee/213726)
- [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/)
- [Copernicus EFFIS rapid damage assessment](https://forest-fire.emergency.copernicus.eu/about-effis/technical-background/rapid-damage-assessment)
- [Copernicus EFFIS data and services](https://forest-fire.emergency.copernicus.eu/applications/data-and-services)
- [Open-Meteo](https://open-meteo.com/)
- [adsb.fi API documentation](https://github.com/adsbfi/opendata)
- [OpenSky data access](https://opensky-network.org/data/)

## Deployment

Production is hosted at [venn-fire.vercel.app](https://venn-fire.vercel.app).

Vercel deploys `main` automatically with `pnpm build`, output directory `dist`, and Node.js 22. Pull requests receive preview deployments. `api/live-situation.js` is a same-origin, fixed-source serverless function with a 60-second CDN cache; it reads public adsb.fi, ADSB.lol and Open-Meteo endpoints and contains no API key.
