# Venn Fire Watch — 15-Minute Interview Cheat Sheet

This is the short version of the [full interview guide](interview-guide.md). Learn the opening script, the three area definitions, the source roles, and the five caveats. Everything else can be reasoned from those.

> The exact live numbers change. The examples below were checked on 18 August 2026 around 12:10 CEST, so always verify the current timestamp before quoting them.

## The one-minute script

> Venn Fire Watch is a five-minute, time-travelable viewer for the High Fens wildfire near Drossart. It brings official reports, satellite heat and imagery, aircraft receiver tracks, weather, rain radar, air-quality forecasts, alerts, and local-authority updates into one PostgreSQL-backed timeline.
>
> The key is that it does not pretend all those sources mean the same thing. The reported area is what authorities published. The Best estimate is our conservative 50 m evidence union. EFFIS is a broader daily algorithmic product. FIRMS points are heat detections, and aircraft paths are receiver positions—not an official perimeter or proof of water drops.
>
> Vercel Functions refresh each source at a sensible cadence, PostgreSQL retains current and historical data plus raw audit artifacts, and the browser reads only that database. The site is useful for situational awareness and reconstructing what was known at a given time, but official authorities remain the source for safety, access, and evacuation decisions.

If you can say that naturally, you already have the main story.

## The three numbers to memorize

1. **Reported area** — a quoted source figure. It is carried forward until another report changes it and can mean “affected,” not uniformly burned.
2. **Best estimate** — the site's derived red outline on a 50 m grid. It combines strict satellite evidence and conservative incident-local aircraft support. It is reproducible but not official.
3. **EFFIS area** — an independent, broad, daily algorithmic VIIRS envelope. It is a comparison, not ground truth, and never modifies the Best estimate.

Audited example: reported about **3,000 ha**, Best estimate **3,057 ha**, EFFIS **6,334 ha**. The disagreement is expected because they answer different questions.

## How the Best estimate works

Remember: **VIIRS core → newest MODIS support → clear Sentinel-2 change → repeated local GRZLY turns → one 50 m union.**

- **VIIRS core:** at least two independent VIIRS spacecraft support the same approximate location, with at least one high-confidence observation.
- **MODIS:** only high-confidence pixels from the newest Terra/Aqua pass can extend an existing supported edge. Its coarse 1 km pixels cannot create the core and old passes do not accumulate forever.
- **Sentinel-2:** compares pre- and post-fire near-/short-wave infrared imagery. Only clear, strong, connected positive dNBR change near the thermal core is added. Cloudy or rejected pixels are unknown, not unburned.
- **Aircraft:** only repeated sharp `GRZLY##` turns near the thermal edge can add small compact lobes. The full route, approach, water-source run, and isolated outliers are excluded. This is support, never proof of a drop.
- **Union:** everything is rasterized to 50 m cells. The red geometry and hectare figure come from exactly the same cells. There is no “touched zone.”

The estimate may shrink when the newest MODIS pass replaces the previous one or 24-hour aircraft support expires. Raw history is still retained.

## What every major source contributes

| Source | What it contributes | What it does **not** prove |
| --- | --- | --- |
| Governor/BRF/local authorities | Reported area and incident chronology | Exact field perimeter |
| FIRMS VIIRS | Independent polar heat detections and the estimate's corroborated core | Burned area from a single pixel |
| FIRMS MODIS | Coarse newest-pass support around an existing edge | Independent core |
| FIRMS Meteosat | Frequent, coarse short-lived thermal context | Hectares or estimate geometry |
| Sentinel-2 | High-resolution positive cloud-clear spectral change | Complete scar or locally calibrated severity |
| EFFIS | Independent broad daily fire geometry | Operational ground truth |
| Sentinel-1/3 | Catalogue, overpass, and preview context | Local change/heat without calibrated or coordinate-level data |
| GIBS | Daily visual satellite imagery | Measured perimeter |
| Aircraft receivers | Exact public receiver positions and complete incident-connected sessions | Mission, payload, water drop, or positions inside gaps |
| RMI/DWD/Open-Meteo | Separate station, radar, and model context | One perfectly blended fire-site weather truth |
| CAMS | Coarse particulate forecasts | Local sensor measurement or plume boundary |
| BE-Alert/municipal feeds/media | Searchable chronology and public communications | A complete archive from before collection began |

## Five facts that prevent most wrong answers

1. **A current poll is not a current observation.** FIRMS may be checked now and return no heat newer than yesterday.
2. **Five-minute granularity is not five-minute source data.** It is the scheduler/timeline grid; satellites, hourly models, ten-minute stations, and daily products keep their real cadence.
3. **No detection is not proof of no fire.** Cloud, smoke, canopy, overpass timing, scan geometry, sensitivity, and receiver coverage all create gaps.
4. **Map visibility is not estimate membership.** Layer switches and FIRMS confidence filters change the drawing, not the estimate algorithm.
5. **Everything important is retained.** PostgreSQL holds current normalized datasets, immutable changed-content versions, refresh runs, raw artifacts, and exact aircraft observations. Public tracks merely fade and disappear after 24 hours.

## Architecture in 20 seconds

```text
Vercel Queue every five minutes
  → refresh function
  → per-source database lease
  → upstream provider
  → PostgreSQL current + history + raw artifact
  → compact no-store API
  → React/Leaflet browser
```

There is no CDN cache and no bundled static incident-data fallback. The database acts as the durable synchronized source, while leases protect limited upstream API allowances. The page is client rendered: it loads the small core view first and aircraft history asynchronously.

The weather panel keeps selected-time observations separate from the latest Open-Meteo outlook. The latter exposes every model hour for the next 48 hours, including rain, cloud, visibility, temperature, wind, and gusts.

## Current-state examples worth knowing

At the audited time:

- FIRMS had 3,234 exact stored detections, with 1,724 visible under default filters.
- The newest heat observation was 17 August at 15:06 CEST, although FIRMS had been successfully checked on 18 August. That means “no newer returned heat,” not “broken ingest” or “confirmed extinguished.”
- The Best estimate was 3,057 ha.
- Sentinel-2 was clear over only 21.9% of the paired crop, which explains why its purple evidence covered only a small part.
- No aircraft was seen on the selected current day; five remained visible in the rolling 24-hour window. Public receiver absence is not flight absence.
- RMI Mont Rigi reported WSW wind from 246°, toward 66°, at 17.7 km/h with 28.3 km/h gusts.
- CAMS values were 54.6 µg/m³ wildfire-only PM10 and 46.6 µg/m³ PM2.5; both are coarse model values, not local sensors.

Do not memorize these as permanent figures—memorize how to explain their timestamps.

## Rapid interview answers

**Is the red outline official?**  
No. It is a transparent, reproducible evidence estimate. Authorities remain authoritative.

**Why are FIRMS points not a perimeter?**  
They are sensor footprints around thermal anomalies at specific times. Resolution and uncertainty differ by product.

**Why is EFFIS so much larger?**  
It is a different daily algorithmic envelope with a different purpose and resolution.

**Why is the Sentinel-2 patch tiny?**  
Only clear, strong, connected positive change is admitted; most of the paired scene was obscured or rejected and is treated as unknown.

**Did the aircraft drop water there?**  
The route may show repeated incident-local manoeuvres, but public receiver data has no payload/drop state. We say “aircraft-supported edge,” never “confirmed drop.”

**Why are there no planes today?**  
No qualifying public receiver observations were retained for that day. Coverage, transponder use, provider history, and actual operations can all explain that; the site cannot infer missing positions.

**Why can the estimate decrease?**  
Newest-pass MODIS support replaces older support, and aircraft-derived support expires after 24 hours. It is a current evidence estimate, not a cumulative scar claim.

**Does the site cache provider data?**  
It stores it durably in PostgreSQL. The public API uses `no-store`; database leases prevent duplicate upstream calls.

**Are PM rectangles real plume edges?**  
No. CAMS is a coarse rectangular model grid. The display feathers the crop edge, but it cannot invent finer spatial detail.

**What data would help most?**  
A timestamped authoritative operational perimeter, verified mission logs, field GPS observations, local calibrated PM sensors, and accessible coordinate-level/calibrated Sentinel products.

## Five caveats to say without hesitation

- Informational viewer, not an emergency service.
- Derived Best estimate, not an official perimeter.
- Thermal anomaly, not automatically burned area.
- Receiver position, not automatically firefighting activity or a water drop.
- Missing/old observations mean “not observed,” not “did not happen” or “fire is out.”

## A strong closing line

> The site's value is not that it claims perfect knowledge. It preserves what each source actually observed or reported, keeps those evidence types separate, makes the derived estimate reproducible, and lets people reconstruct what was knowable at each point in time.
