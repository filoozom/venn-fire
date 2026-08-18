# Venn Fire Watch — Interview Guide

This document explains what the public viewer shows, how each result should be interpreted, where the data comes from, and what the system can and cannot establish. It is intended as a detailed interview reference.

For a short version that can be learned in roughly 15 minutes, see the [interview cheat sheet](interview-cheat-sheet.md).

> Snapshot note: figures in the “Current audited snapshot” section were checked on **18 August 2026 at about 12:10 CEST**. They are examples of the live system state, not permanent values. The production viewer and database continue to update.

## The 30-second explanation

Venn Fire Watch is a five-minute, time-travelable observation viewer for the High Fens wildfire around Drossart, Baelen, and Jalhay. It combines official situation reports, satellite heat detections and imagery, aircraft receiver tracks, weather observations and forecasts, precipitation radar, air-quality forecasts, public alerts, and local-authority notices.

Vercel Functions collect those sources on controlled schedules. Every current dataset, meaningful historical version, source refresh result, and raw audit artifact is retained in PostgreSQL. The browser reads only the database-backed API; it never calls the upstream providers directly and has no bundled static incident-data fallback.

The most important design decision is that the viewer keeps different kinds of evidence separate:

- **Reported area** is what an authority or cited report stated.
- **Best estimate** is the site's conservative, evidence-derived 50 m outline.
- **EFFIS area** is a broader daily algorithmic satellite product.
- **FIRMS detections** are individual thermal anomalies, not a perimeter.
- **Aircraft tracks** are receiver-supported positions, not proof of a firefighting task or water drop.
- **Weather, radar, and air quality** provide environmental context; they do not alter the fire outline.

The viewer is informational. It is not an emergency service, an official operational perimeter, an evacuation tool, or proof that an area is safe or extinguished.

## Current audited snapshot

The following values illustrate what was present when this guide was written. Always read the live timestamps before quoting them.

| Item | Audited value | Correct interpretation |
| --- | ---: | --- |
| Latest reported affected area | About **3,000 ha** | The newest sourced public figure, carried forward until another report changes it. “Affected” does not necessarily mean uniformly burned. |
| Best estimate | **3,057 ha** | The area of the displayed 50 m evidence union, not an official perimeter. |
| Evidence behind that estimate | 1,066 corroborated VIIRS records; 4 qualifying high-confidence Terra MODIS pixels from the newest pass; 796 clear Sentinel-2 support cells; 308 aircraft-supported cells from repeated GRZLY80 turns | Inputs are admitted under different rules. Counts must not be added as hectares. |
| EFFIS | **6,334 ha** | A broader daily algorithmic VIIRS geometry; useful as an independent comparison, not a field-surveyed boundary. |
| FIRMS | **1,724 visible** with the default filters; **3,234 exact detections stored** | “Visible” depends on selected time, sensor, confidence, and short-lived Meteosat rules. Stored history is larger. |
| Newest FIRMS heat observation | **17 August, 15:06 CEST** | NASA was successfully checked later, on 18 August around 12:02 CEST, but the response contained no newer local heat. A fresh poll and a fresh detection are different things. |
| Aircraft | **0 seen on the selected current day**, 5 visible within the rolling 24-hour display window | The latest retained GRZLY80 observation was 17 August at 22:41 CEST. No public receiver observation is not proof that no aircraft flew. |
| Headline weather | WSW from 246°, blowing toward 66°; 17.7 km/h, gusting 28.3 km/h; 14 °C; 97.2% relative humidity | Near-real-time Mont Rigi station data, marked preliminary. Direction is where the wind comes **from**; the viewer also states where it blows **toward**. |
| Latest precipitation at the incident | RMI: none detected at the selected frame | A categorical radar observation, not proof that every point on the ground was dry. |
| Sentinel-2 comparison | Pre-fire 14 August about 12:47 CEST; post-fire 16 August about 12:47 CEST; 21.9% clear; 187.92 ha raw qualifying change; 796 accepted 50 m cells, equal to 199 ha before overlap with other evidence | Only clear, qualifying positive spectral change is shown. The unobserved majority is unknown, not unburned. |
| Sentinel-3 | 12 incident-intersecting passes; 0 local coordinate detections | Catalogue intersections and previews exist, but no coordinate-level local FRP rows were publicly usable. |
| Sentinel-1 | 30 acquisitions; 2 comparable pairs; 0 calibrated change analyses | Catalogue and preview context only. It does not currently modify the estimate. |
| Copernicus EMS | 0 incident matches | No matching activation was found in the synchronized catalogue. EMSR920 near Hürtgen was a separate event about 32 km away. |
| NASA GIBS | 10 retained images through 18 August | Daily visual context, not a measured perimeter. |
| CAMS | 54.6 µg/m³ experimental wildfire-only PM10; 46.6 µg/m³ PM2.5 | Coarse 0.1° model-grid forecast values, not local air-quality sensor readings. |
| Retained radar history | DWD: 1,019 five-minute frames from 14 August 11:05 UTC through 17 August 23:55 UTC; RMI: 116 retained frames in the audited response | DWD's quantitative archive normally appears after a UTC day completes; RMI supplies the rolling near-real-time categorical context. |
| Database | 27 current datasets; 1,548 dataset versions; 9,632 artifacts; about 913 MB of original source bytes | A point-in-time storage audit. Counts grow as sources change and artifacts are retained. |

## The three area figures people most often confuse

### Reported area

The reported area is a number quoted from a source publication, such as the Governor of Liège or BRF. The viewer preserves qualifiers such as approximately (`~`) or greater than (`>`). If no numeric area was stated, it displays a dash.

The value changes only when a sourced report changes it. Between reports, the last known value is carried forward; the viewer does not interpolate. It is an “affected area” report and may include a mixture of burned, burning, threatened, inaccessible, or operationally enclosed ground depending on the publisher's meaning.

### Best estimate

The Best estimate is the area of one solid red 50 m raster union derived by the site. It combines only qualifying evidence from corroborated VIIRS detections, the newest supported MODIS pass, positive cloud-clear Sentinel-2 change, and tightly constrained incident-local GRZLY aircraft-turn evidence.

It is deliberately named an estimate. It is neither official nor a field-surveyed perimeter, and it is not advertised as an upper or lower bound. The displayed number and displayed outline are calculated from the same grid, so they cannot silently disagree.

### EFFIS area

EFFIS supplies a daily algorithmic VIIRS geometry. The viewer selects the product nearest the incident and calculates the local polygon's area. It is useful as an independent broad envelope and can legitimately be much larger than the site's estimate because its purpose, resolution, compositing, and classification method differ.

EFFIS is not treated as ground truth and never changes the Best estimate.

## Everything visible on the website

### Header and load state

The header identifies the incident and location, exposes the current observation time, shows the latest database synchronization state, and opens the “Data & sources” explanation.

“Latest” describes the database or refresh state. It does not imply that every upstream instrument produced a new observation at that exact time. For example, FIRMS can have a successful poll at noon while its newest local satellite detection remains from the previous afternoon.

The application paints its shell immediately, then asynchronously loads the compact core dataset and the larger aircraft projection. The public interface does not show an implementation-oriented “Loading incident database” screen.

### Left information panel

The main panel includes:

- the incident and locality;
- reported area, Best estimate, and their timestamps or method descriptions;
- the Best estimate outline control;
- map-layer toggles;
- FIRMS confidence filters;
- source freshness and availability information; and
- the emergency-information disclaimer.

Layer switches change what the map draws. They do not retrospectively recalculate the estimate. Turning MODIS or aircraft tracks off, for example, hides those visual layers but does not remove already qualified evidence from the Best estimate.

### Base maps and map controls

The viewer offers:

- OpenStreetMap as the normal map base;
- Esri satellite imagery; and
- OpenTopoMap terrain context.

Controls cover zoom, return-to-home extent, return-to-fire extent, and straight-line distance measurement. The displayed incident coordinate is a reference position for the event, not a claimed centimetre-accurate ignition point or operational command-post location.

### Distance measurer

The ruler measures straight-line distance between clicked map points and can continue across multiple segments. It is useful for questions such as “How far is the outline from this town?” Press Escape or use the clear action to reset it.

It is not a road distance, travel time, evacuation radius, terrain-aware path, or safety buffer.

### Five-minute timeline

The timeline begins on 14 August at 13:00 CEST, just before the reported ignition at roughly 13:06. It exposes five-minute frames, even when an upstream source has a coarser cadence.

The interface provides:

- previous and next frame controls;
- play and pause;
- 1×, 2×, and 4× playback;
- a draggable time slider;
- report and incident-event markers;
- a step chart for the reported area; and
- keyboard support, including arrow keys and Space.

Evidence is time-gated. A satellite observation, report, or aircraft fix appears only after its actual acquisition or publication time; later information is not leaked backward into earlier frames. A flat area line means there was no newly published area figure, not necessarily that the fire stopped changing.

### Situation tab

The Situation tab summarizes six main signals:

- latest reported affected area;
- current Best estimate;
- EFFIS area;
- FIRMS detections visible under the current filters;
- aircraft seen on the selected day; and
- headline wind.

It also shows fire-weather context, independent wind sources, and a chronological incident log with clickable sources. Independently measured or modelled winds stay separate rather than being blended into a false “super-observation.”

A separate Open-Meteo outlook shows every model hour for the next 48 hours, including temperature, feels-like temperature, precipitation probability and amount, cloud, visibility, wind, and gusts. It is explicitly tied to the latest database synchronization and remains separate from the selected historical observation.

### Aircraft tab

The Aircraft tab shows callsign or identity, aircraft type where known, candidate/verified status, selected-day and rolling-24-hour fix counts, route clusters, available reference photographs, and provenance. Controls can fit a selected route or the full selected day.

Aircraft with a public photograph but no suitable receiver trace can still be listed as photo-only context; G12 is one such case. A visible route always represents exact retained receiver positions, with gap rules described later in this document.

### Data & sources dialog

The public “Data & sources” dialog explains:

- current coverage at a glance;
- how to read FIRMS, the Best estimate, Sentinel products, radar, weather, GIBS, CAMS, and aircraft evidence;
- the source directory and source links; and
- a neutral invitation to contact the project if someone has access to useful operational data.

Internal credentials, provider-contract speculation, synchronization gaps, and implementation-only limitations are deliberately kept out of the public website. Those are maintained in [the internal source-limit inventory](known-source-limits.md).

### Local aircraft-file import

The viewer can display a user-supplied GeoJSON `LineString` or CSV containing latitude, longitude, and optional callsign information. This is a local analysis aid. Imported data is treated as static/timeless, stays in that browser session, is not uploaded to PostgreSQL, and is not shared with other visitors.

## Map layers and whether they affect the Best estimate

| Layer | Default | Can affect Best estimate? | Purpose |
| --- | --- | --- | --- |
| Best estimate outline | On | It **is** the estimate | Solid red derived evidence union and matching area. |
| EFFIS | On | No | Broad independent daily algorithmic envelope. |
| Sentinel-2 change | On | Yes, under the documented clear-pixel rules | Positive cloud-clear burn-consistent spectral change. |
| Sentinel-3 | On | No in the current data | Catalogue/preview context; only coordinate-level FRP could become local points. |
| Precipitation radar | On | No | RMI near-real-time and DWD quantitative rain context. |
| GIBS true colour | Off | No | Daily visual satellite context. |
| GIBS short-wave infrared | Off | No | Daily visual context that can make hot/burned features easier to inspect. |
| CAMS wildfire PM10 | Off | No | Experimental model forecast of wildfire-attributable PM10. |
| CAMS PM2.5 | Off | No | Coarse particulate forecast context. |
| VIIRS Suomi-NPP | On | Yes, through corroboration rules | 375 m-class polar thermal detections. |
| VIIRS NOAA-20 | On | Yes, through corroboration rules | Independent 375 m-class polar thermal detections. |
| VIIRS NOAA-21 | On | Yes, through corroboration rules | Independent 375 m-class polar thermal detections. |
| MODIS Terra/Aqua | Off | Only the newest qualifying supported pass | 1 km-class thermal support; never creates the core alone. |
| Meteosat | Off | Never | Frequent but very coarse geostationary thermal context. |
| Aircraft tracks | On | Only filtered, repeat-supported `GRZLY##` turn evidence | Receiver-supported routes and conservative local edge evidence. |
| Open-Meteo wind | On | No | Hourly model-grid weather. |
| RMI Mont Rigi wind | On | No | Nearby ten-minute weather-station observations. |
| Three DWD winds | On | No | Independent nearby ten-minute station observations. |

High and nominal FIRMS confidence are visible by default; low confidence is hidden by default. These controls affect the visible FIRMS count, not the stored source total and not the independently defined Best estimate qualification rules.

## How the Best estimate is built

### 1. Time gating

Every calculation uses only evidence whose acquisition time is at or before the selected timeline frame. The same algorithm can therefore reconstruct what the viewer could reasonably have shown at any five-minute point without using future evidence.

### 2. Corroborated VIIRS core

The thermal core uses the three VIIRS polar products: Suomi-NPP, NOAA-20, and NOAA-21. Detections are grouped on an approximately 0.005° spatial grid, roughly 500 m in this location.

A core location requires:

1. observations from at least two independent VIIRS spacecraft; and
2. at least one high-confidence detection.

Corroboration is spatial and cumulative up to the selected time; the satellites do not need to pass simultaneously. Accepted published footprints are rasterized onto the common 50 m grid.

This rule reduces the chance that a single noisy or displaced satellite point defines a large edge by itself, but it can still miss fire hidden by cloud, smoke, scan gaps, or overpass timing.

### 3. Newest-pass MODIS support

MODIS Terra and Aqua have coarser, roughly 1 km thermal pixels. MODIS can extend the existing estimate only when all of the following hold:

- the detection has high confidence;
- it belongs to the newest available five-minute Terra/Aqua pass at the selected time; and
- its qualifying footprint is within 500 m of the corroborated VIIRS core or an accepted aircraft-supported edge.

MODIS cannot create an independent core and does not count as a second VIIRS spacecraft. Only the newest supported pass is used, so successive coarse snapshots do not accumulate forever into an inflated scar. This also means the estimate need not be monotonically increasing. On 15 August, for example, replacement of one supported MODIS pass by the next changed the estimate from roughly 3,572 ha to 3,012 ha.

### 4. Sentinel-2 positive change support

Sentinel-2 contributes higher-resolution optical evidence from a pre-fire and post-fire L2A scene. The analysis uses:

- B8A near-infrared;
- B12 short-wave infrared; and
- the 20 m Scene Classification Layer, or SCL.

The Normalized Burn Ratio is:

```text
NBR = (B8A - B12) / (B8A + B12)
dNBR = pre-fire NBR - post-fire NBR
```

Only SCL class 4 (vegetation) or 5 (not vegetated) in both scenes is accepted. Cloud, cirrus, shadow, water, snow, unclassified, and missing pixels are rejected.

A 20 m pixel becomes eligible when its dNBR is at least 0.15 and its centre lies within 750 m of an independently corroborated VIIRS core observation available by the post-fire acquisition time. It enters the shared 50 m grid only if:

1. at least two eligible 20 m pixels fall in that 50 m cell;
2. at least one has dNBR of 0.20 or more; and
3. the cell belongs to a four-neighbour connected component of at least four cells.

Sentinel-2 adds positive evidence only. It never erases thermal or aircraft evidence because an obscured or non-qualifying pixel does not establish that the ground was unaffected.

In the audited comparison, the pre-fire scene was acquired on 14 August around 12:47 CEST and the post-fire scene on 16 August around 12:47 CEST. Only 21.9% of the crop was clear in both scenes. The resulting small patches are therefore expected: they show where the method has positive, cloud-clear support, not the only ground that burned.

The full retained raster method is documented in [Sentinel-2 burn-change analysis](sentinel2-analysis.md).

### 5. Aircraft-supported edge

Only incident-related `GRZLY##` callsigns can contribute aircraft evidence. The estimate does not consume an entire route: reservoir runs, approaches, departures, and distant transit legs are excluded.

The incident-local algorithm:

1. resamples retained exact positions into ten-second display buckets;
2. looks 15–45 seconds before and after a candidate turn;
3. requires flight legs of at least 100 m;
4. requires a direction change of at least 70°;
5. requires the turn to be between 50 m and 1 km from the existing thermal outline;
6. accepts at most one evidence point per five-minute frame; and
7. requires support from another five-minute frame within 900 m.

Each disconnected local cluster creates only its compact, shortest boundary lobe against the thermal outline. That lobe is rasterized into the same 50 m union. Long strips from the water source, route connectors, and isolated triangular outliers are not included.

This is evidence of a repeated manoeuvre pattern near the thermally supported edge. Public receiver data contains no payload state and no authoritative mission record, so the result is not proof of a water drop, a fire-front position, or even the aircraft's assigned task.

Aircraft contribution expires from the current Best estimate after 24 hours, matching the relevance window for track display. Exact historical observations remain in PostgreSQL.

### 6. One dissolved 50 m union

All accepted evidence is rasterized on the same 50 m grid and dissolved into one geometry. A full grid cell represents 2,500 m², or 0.25 ha. Overlap is counted once. The displayed hectares are calculated from exactly the cells drawn in the red outline.

There is no separate “touched zone.” It was removed because its outer historical edge looked more authoritative than the evidence justified.

### What the estimate can still get wrong

It can under-estimate because satellites have limited overpasses, cloud and smoke obscure optical observations, public aircraft receivers have gaps, and no field perimeter feed is available. It can over-estimate because thermal footprints are larger than the actual flaming surface, spectral change is not uniquely caused by fire, and conservative raster cells include some surrounding ground.

For those reasons, it should be described as a reproducible evidence estimate—not “the true burned area,” “the fire front,” or an official perimeter.

## NASA FIRMS thermal detections

FIRMS is the main source of raw satellite heat observations. The viewer synchronizes five products.

| Product | Approximate native footprint/cadence | Default visibility | Role in estimate |
| --- | --- | --- | --- |
| VIIRS Suomi-NPP | About 375 m; roughly two polar overpasses per day | On | May contribute to the corroborated core. |
| VIIRS NOAA-20 | About 375 m; roughly two polar overpasses per day | On | May contribute to the corroborated core. |
| VIIRS NOAA-21 | About 375 m; roughly two polar overpasses per day | On | May contribute to the corroborated core. |
| MODIS Terra/Aqua | About 1 km; up to roughly four combined opportunities per day | Off | Only newest high-confidence supported pass may extend the core. |
| GOES_NRT Meteosat | Roughly 2.1 × 4.1 km to 3.3 × 9.1 km here, depending on spacecraft/viewing geometry; usually 10–15 minutes | Off | Visual context only; never contributes hectares. |

The Meteosat rectangles are explicitly approximate viewing-geometry footprints. The source's `scan` and `track` columns are retained for provenance but are not physical kilometre dimensions for these products.

FIRMS confidence is shown as high, nominal, low, or unknown according to the provider's product-specific field. Fire Radiative Power, or FRP, is a relative measure of radiant energy in megawatts at the observation time. It is not temperature, burned area, fire duration, or a direct severity score.

Polar detections remain available on the historical timeline. Meteosat is an instantaneous, coarse context layer and fades after its 15-minute scan window. All underlying rows remain stored.

The service is checked by the five-minute scheduler, but a 15-minute database lease protects the limited NASA API allowance. Every successful poll merges exact rows into history and archives the five raw product responses. The UI distinguishes:

- `generatedAt`: when the provider was queried; and
- `latestAcquiredAt`: when the newest returned satellite observation was acquired.

Therefore “checked just now, three rows returned, no newer heat” is a valid and important state. It does not mean the ingestion is stale, and it does not prove the fire is out. A satellite can miss residual or obscured heat, and local detections appear only when the instrument observes and the provider publishes them.

## Other satellite and Copernicus products

### EFFIS

The Copernicus European Forest Fire Information System WFS is polled every six hours for a daily product. The site selects the geometry nearest the incident within the configured local search and calculates its local polygon area. The orange outline is carried forward on the timeline until a newer daily product arrives. It never alters the Best estimate.

### Sentinel-2

Copernicus Data Space supplies authoritative catalogue records and retained public quicklooks. Element 84 Earth Search and the AWS Open Data Sentinel-2 L2A COG archive supply the public B8A, B12, and SCL pixels used for the retained dNBR analysis.

The catalogue is checked every five minutes, but large raster assets are processed only when an unseen post-fire scene appears. The source record exposes acquisition times, cloud/clear fraction, raw qualifying area, accepted cell count, and the resulting evidence geometry.

A small purple patch is not a failure when most of the paired scene is obscured or rejected. It means only that the patch is the part for which the strict method has positive, clear evidence.

### Sentinel-3

The Sentinel-3 SLSTR NRT FRP catalogue is checked every 30 minutes. Incident-intersecting overpasses and public previews are retained. A catalogue intersection or swath preview is not automatically a local heat point. Only coordinate-level FRP rows can be drawn as local detections.

At the audited time, 12 passes intersected the incident search but none exposed usable local coordinates, so Sentinel-3 correctly added no map detections and no area.

### Sentinel-1

Sentinel-1 GRD catalogue records are checked hourly. Acquisitions are paired only when they use the same spacecraft, relative orbit, and pass direction. Public previews can provide visual context, but they are not georeferenced, calibrated change rasters and therefore do not affect the Best estimate.

At the audited time, the database held 30 acquisitions and two comparable pairs, but no valid pixel-level change analysis.

### NASA GIBS

GIBS supplies daily VIIRS corrected-reflectance imagery: true colour plus M11/I2/I1 short-wave-infrared context. The scheduler checks for same-day revisions every 30 minutes and retains distinct versions. These are visual images, not local hotspot measurements, exact within-day acquisition records, or perimeter products.

### Copernicus Emergency Management Service

The EMS Rapid Mapping catalogue is checked hourly. A match would expose activation metadata and available mapping products. No matching activation was found for this incident in the audited catalogue. EMSR920 near Hürtgen was a separate event roughly 32 km away and is not imported into this incident.

“No match” means only that no matching activation was found through the synchronized public catalogue. It is not proof that no authority created internal operational mapping.

## Weather and wind

The headline weather prefers the nearby RMI Mont Rigi observation when it is no more than 20 minutes old. Otherwise it falls back to Open-Meteo. The source and observation time are always shown.

Wind direction follows the meteorological convention: 246° means wind **from** 246°, approximately west-south-west. The interface also translates that into the direction it blows **toward**, in this example 66°.

Values are rounded to meaningful precision: whole-degree wind direction, sensible decimal precision for speed and temperature, and no floating-point artifacts such as `116.25560000000002°`.

### RMI Mont Rigi

RMI station 6494 is about 4.2 km from the incident reference point. It supplies ten-minute temperature, relative humidity, precipitation, wind, gust, and validation flags. Near-real-time values can be marked preliminary pending provider validation.

### Open-Meteo

Open-Meteo supplies hourly model-grid temperature, feels-like temperature, humidity, precipitation probability and amount, weather code, cloud, visibility, wind, and gust rows. The application checks for refreshed data every five minutes and exposes at least the next 48 hours as a separate forecast. It is a model value for a grid cell, not a station observation at the fire.

### DWD stations

Three DWD CDC stations provide independent ten-minute wind observations:

- Aachen-Orsbach, about 28.0 km away;
- Kall-Sistig, about 33.5 km away; and
- Roth bei Prüm, about 35.7 km away.

Observations remain visible for up to 90 minutes. Their quality level is retained, and they are never silently blended with RMI or Open-Meteo.

## Precipitation radar

The precipitation layer is on by default and combines two sources:

- **RMI public radar animation:** near-real-time categorical precipitation images, checked every five minutes and currently published at ten-minute timestamps.
- **DWD RADOLAN YW:** official quantitative 1 km precipitation amounts every five minutes, recovered from completed daily archives.

RMI wins when the sources have an exact overlapping frame because it is the live context. DWD provides the exact millimetres per five-minute interval once the relevant daily archive is published. The viewer does not interpolate between radar frames.

DWD's public archive normally lags until the UTC day is complete. The ingest checks every five minutes, stores every available original archive and incident-area frame, and leaves unpublished days explicitly pending. RMI provides current context during that lag, but its public image is categorical rather than a millimetre measurement.

Historical precipitation is retained in PostgreSQL. What the interface does not currently provide is a cumulative-rain chart; retention and visualization are separate concerns.

Radar shows energy detected above the ground over a grid. “None detected at this point” is not proof that every part of the incident was dry or that precipitation reached the surface.

## CAMS particulate forecasts

CAMS supplies two optional layers:

- experimental wildfire-only PM10; and
- PM2.5.

They are hourly Copernicus ensemble forecasts on a coarse 0.1° grid, roughly 10 km here. They are not local sensor measurements and do not describe the fire geometry. The wildfire-only attribution is itself modelled.

The database retains both the georeferenced forecast crop and exact incident-grid values. The public colour style saturates at 500 µg/m³. The image edge is feathered so that the rectangular data crop is not mistaken for the boundary of a pollution plume; any remaining grid-like appearance comes from the product's coarse model cells.

## Aircraft data

### Discovery and qualification

The live ingest uses one geographic point request per provider from adsb.fi and ADSB.lol, covering roughly ten nautical miles around the incident. Airplanes.live is retained as a provider-health/completed-trace source where available. Raw responses are archived.

An aircraft near the fire is retained only when at least one of these supports incident relevance:

- its exact Mode-S identity was previously verified for the incident;
- it broadcasts an explicit `GRZLY##` callsign; or
- type, description, rotorcraft category, or military metadata supports a response-aircraft candidate classification.

The qualifying observation must be within 10 km of the incident, no more than 120 seconds old, no higher than 8,500 ft, and no faster than 250 kt. Multiple receivers corroborate a position, not the aircraft's mission.

### Complete routes

Once a qualified aircraft session enters the incident radius, the system retrieves and retains the complete receiver-supported session from takeoff-side observations through landing-side observations wherever the provider trace reaches. It does not attach unrelated same-day sessions elsewhere.

Exact fixes are stored in PostgreSQL. The browser receives at most one exact fix per aircraft per ten-second bucket to stay responsive. Gaps longer than two minutes or implied connectors faster than 300 kt are left as gaps. No point is interpolated simply to make a continuous-looking line.

Tracks fade linearly as they age and disappear from the public map after 24 hours. This is a display rule, not deletion: historical fixes remain in the database.

### Known and candidate incident aircraft

The identity list retained by the project includes:

- G10, G17, and G12, with G12 currently photo-only where no suitable trace is available;
- `GRZLY81` / D-472;
- `GRZLY80` or `GRZLY91` / D-604;
- `GRZLY81` / D-479;
- `GRZLY80` / D-606;
- `GRZLY80` / D-483;
- `HUMMEL6` / D-HNWW, EC145 candidate;
- `LNOYP` / LN-OYP, AS350 candidate; and
- `TGT42` / SE-MHN, AT-802 candidate.

Callsigns can be reused across airframes and days, which is why Mode-S identity and timestamps matter.

Reviewed exclusions include OOVST/OO-VST, the QTR8098 Boeing 777 transit, and unrelated Aachen/Walheim MLAT traffic. They remain in raw source artifacts for audit but are not promoted into the incident viewer.

### What a track proves

A point proves only that a provider reported that transponder/receiver position at that time, subject to receiver and metadata error. A route does not prove firefighting assignment, water pickup, water drop, payload state, or the exact fire front. Absence of a track does not prove absence of a flight: transponder operation, receiver coverage, MLAT quality, provider history, and data publication all impose gaps.

## Official reports and incident chronology

Reported hectares are preserved with both the report's stated effective time and its publication time. The timeline does not force values to be monotonic because publishers can revise scope, use different definitions, or issue approximate figures.

| Effective/publication point | Sourced figure | Source context |
| --- | ---: | --- |
| 14 August, about 16:00 | ~60 ha | Governor of Liège |
| 14 August, about 20:00 | ~100 ha | Governor of Liège |
| 15 August, about 07:00 | ~850 ha | Governor of Liège |
| 15 August, 11:28 | >900 ha | BRF |
| 15 August, 14:30 | >1,500 ha | BRF |
| 15 August, effective about 18:00 and published around 21:00 | ~2,700 ha | Governor of Liège |
| 15 August, 21:16 | >2,000 ha | BRF |
| 16 August, about 21:00 | ~3,000 ha | Governor of Liège |

A value appears only after its publication is available to the viewer, even if the article describes an earlier effective time. This prevents hindsight from leaking onto an earlier timeline frame.

The incident log also retains official situation updates, named-street evacuation information, the reported plan for nine aircraft, municipal and emergency-service notices, public BE-Alert CAP records, and clearly labelled local-media reporting. Event categories are derived for navigation; the linked publication remains the source.

Expired BE-Alert records are accumulated after they disappear from the live feed. An empty search result means no matching alert was collected, not proof that no alert existed before collection began. Broad provider-feed relevance filters can also miss differently worded notices.

## The 18 synchronized source groups

The scheduler runs on a five-minute grid, but every provider keeps its own sensible lease and native measurement cadence.

| Source group | Check/lease cadence | Native data cadence or role |
| --- | ---: | --- |
| Aircraft point discovery, archived-response recovery, and current traces | 5 min | Exact receiver observations as providers publish them. |
| Open-Meteo | 5 min | Hourly model rows. |
| Governor of Liège and BRF reports | 5 min | Publication-driven. |
| Local authorities and emergency services | 5 min | Publication-driven. |
| Vedia local media | 5 min | Publication-driven. |
| BE-Alert CAP | 5 min | Live alert feed plus retained expired records. |
| RMI Mont Rigi station | 10 min | Ten-minute observations. |
| RMI precipitation radar | 5 min check | Public frames currently every ten minutes. |
| DWD RADOLAN precipitation | 5 min publication check | Five-minute observations in completed daily archives. |
| DWD wind stations | 10 min | Ten-minute observations. |
| NASA FIRMS, five products | 15 min | Sensor/overpass dependent. |
| NASA GIBS | 30 min check | Daily imagery and same-day revisions. |
| Copernicus EFFIS | 6 h | Daily algorithmic product. |
| Copernicus EMS | 60 min | Activation catalogue. |
| Sentinel-2 | 5 min catalogue check | Raster processing once per unseen post-fire scene. |
| Sentinel-3 | 30 min | NRT FRP catalogue/overpass dependent. |
| Sentinel-1 | 60 min | Orbit/acquisition dependent. |
| Copernicus CAMS | 60 min | Hourly model forecast. |

The local-authority group covers Stavelot, Malmedy, Jalhay, Baelen, Eupen, Waimes, Bütgenbach, Zone de Secours Vesdre-Hoëgne & Plateau, Hilfeleistungszone DG, and Eifel Police.

“Five-minute granularity” means the system can schedule, store, and replay five-minute timeline buckets. It does not create five-minute satellite overpasses, hourly forecasts, daily polygons, or news publications.

## Architecture, storage, and refresh behavior

### Browser architecture

The frontend is a React/Vite/Leaflet single-page application, not server-side rendered HTML. It renders the shell immediately, requests `/api/data?scope=core`, displays the incident, and then loads `/api/data?scope=aircraft` asynchronously. Both reads repeat every five minutes with `cache: 'no-store'`.

There is no bundled static incident dataset and no browser call to a source provider. Base-map tiles remain external, and a user-selected local import remains local to that browser.

### Data flow

```text
Vercel Queue delayed wake-up
  → private refresh function
  → per-source PostgreSQL lease
  → fixed upstream provider
  → normalized current dataset
  → immutable changed-content version
  → raw content-addressed artifact
  → compact public database projection
  → browser API
  → five-minute timeline
```

All incident API responses emit browser, CDN, and Vercel-CDN `no-store` headers. There is no CDN data cache. Database-backed current projections make reads efficient, while leases prevent repeated browser requests, queue retries, GitHub fallbacks, or overlapping deployments from multiplying upstream API calls.

### PostgreSQL tables

- `app_datasets`: latest complete normalized payload for each dataset.
- `app_dataset_versions`: immutable historical versions when meaningful source content changes.
- `app_public_datasets`: compact projections optimized for the public browser response.
- `source_refresh_runs`: every claimed source/time bucket, including successful unchanged polls, errors, and item counts.
- `refresh_scheduler_ticks`: deployment/wake-up ownership and duplicate-message protection.
- `source_artifacts`: content-addressed raw responses, satellite quicklooks, clipped raster arrays, radar data, imagery, and forecast products.
- `flight_import_runs`: idempotent flight-history recovery/import bookkeeping.
- `flight_observations`: exact deduplicated receiver fixes.

Semantic content hashes exclude volatile retrieval timestamps. An unchanged poll therefore produces a refresh-run audit record without needlessly creating a new dataset version.

The audited database contained 27 current datasets, 1,548 content versions, 9,632 artifacts, and about 913 MB of original source bytes. These values are dynamic.

### Historical recovery

The database includes one-time, checksum-validated recovery of data that predated the database cutover, including:

- the 51 exact early aircraft observations from the immutable repository revision;
- five historical reported-area rows;
- two earlier EFFIS daily products;
- provider-supported completed aircraft routes;
- FIRMS ignition-day recovery; and
- available DWD historical precipitation archives.

Completion fingerprints prevent the system from repeatedly consuming provider allowance for the same recovery.

### Continuous scheduler

The primary wake-up is a Vercel Queue message scheduled for minute 02/07/12/... of each hour. The private consumer schedules the next delayed message before refreshing the leased sources. Queue delivery can retry without duplicating source calls.

A GitHub Action runs every 15 minutes as a fallback and deployment bootstrap. It first waits for the production alias to serve the intended commit, then makes one refresh call. A daily Vercel cron provides another recovery path suitable for the current plan limits.

Scheduler ownership is pinned to the active deployment. When a new release takes over, the old queue chain stops. This is why a deployment-wait workflow must compare the deployed Git SHA before claiming refresh ownership.

## What the website cannot establish

The following are interpretation boundaries, not excuses to ignore the data:

- It cannot replace official safety, access, evacuation, or emergency instructions.
- It cannot provide a field-surveyed operational perimeter without such a source.
- It cannot prove that the fire is extinguished merely because FIRMS returns no new local heat.
- It cannot prove a water pickup, water drop, payload state, or mission assignment from ADS-B/MLAT tracks.
- It cannot reconstruct positions inside receiver gaps without inventing data, which it deliberately avoids.
- It cannot see fire hidden from a satellite by cloud, smoke, canopy, scan geometry, sensitivity, or overpass timing.
- It cannot turn dNBR into a locally validated severity class without field calibration.
- It cannot turn Sentinel-1 or Sentinel-3 catalogue intersections or preview images into local measurements without coordinate-level/calibrated pixels.
- It cannot treat CAMS as a local PM sensor or infer a plume boundary from the model crop.
- It cannot provide quantitative RMI rainfall from categorical public imagery.
- It cannot eliminate DWD's completed-day archive publication lag.
- It cannot assign an exact within-day acquisition time to every daily GIBS composite.
- It cannot use the ruler as a road route, evacuation distance, or safety margin.
- It does not yet graph cumulative historical rainfall, although the individual historical frames are retained.
- It cannot infer that no operational mapping exists solely because the public EMS catalogue has no match.
- It must distinguish an unchanged successful poll from a failed refresh and from a genuinely new observation.

## Interview questions and concise answers

### “Why are there three different area figures?”

They answer different questions. Reported area repeats a publisher's stated affected area. Best estimate is the site's reproducible 50 m union of qualifying evidence. EFFIS is an independent, broader daily algorithmic satellite product. Presenting them separately is more honest than forcing them into one number.

### “Is the Best estimate official?”

No. It is a transparent derived estimate. It has explicit admission rules, uses only evidence available by the selected time, and keeps its geometry and hectare value consistent. Authorities remain authoritative for operational boundaries and safety.

### “Why can FIRMS be up to date while the latest detection is old?”

The feed can be queried successfully without a satellite returning a new local heat anomaly. `generatedAt` is the query time; `latestAcquiredAt` is the newest observation time. Overpass timing, cloud, scan geometry, sensitivity, and actual fire behavior all affect whether a new row appears.

### “Why not just draw a polygon around every FIRMS pixel?”

Each product has a different footprint and false-positive/displacement risk. Uniting every point would overstate certainty and count repeated coarse observations as new burned ground. The estimate requires independent VIIRS corroboration and tightly restricts coarser or indirect support.

### “Why can the estimate get smaller?”

It is an evidence estimate for the selected time, not a cumulative burned-area claim. The algorithm uses only the newest qualifying MODIS pass and expires aircraft edge evidence after 24 hours. Replacing temporary support can remove cells while all raw history remains available.

### “Why does Sentinel-2 show only a small part?”

The paired scenes were clear over only part of the crop, and the method admits only strong connected positive dNBR near independently corroborated thermal evidence. Obscured or rejected pixels are unknown, not unburned, and never erase other evidence.

### “Do aircraft turns prove where water was dropped?”

No. They show repeated sharp manoeuvres near a thermally supported edge. Public receiver feeds do not expose payload or drop state. The algorithm deliberately excludes distant routes and labels the result as aircraft-supported evidence rather than a confirmed drop line.

### “Does everything update every five minutes?”

The scheduler and timeline have five-minute granularity. Providers retain their native cadence: RMI and DWD stations are ten-minute, Open-Meteo and CAMS are hourly, FIRMS depends on satellite passes, and EFFIS/GIBS are daily products.

### “Does it cache the data?”

It does not use a browser or CDN cache for incident APIs. PostgreSQL is the durable data store and read projection. Per-source leases reuse the already synchronized database state and stop repeated refresh triggers from consuming limited provider calls.

### “Is the page server-side rendered?”

No. It is a lightweight client-rendered React application. The shell appears first, the core database projection loads immediately, and the much larger aircraft history loads asynchronously. That keeps the first useful view small without shipping stale local snapshots.

### “Why do PM layers look rectangular or blocky?”

CAMS is a coarse 0.1° gridded model product delivered over a rectangular regional crop. The crop edge is feathered so it is not presented as a plume boundary, but the underlying grid cells remain visible. It is not a local sensor map.

### “What would improve confidence most?”

A timestamped authoritative operational perimeter would provide the largest improvement. Useful additions would also include verified incident flight/mission logs, field GPS observations, calibrated local air-quality sensors, and accessible coordinate-level or calibrated Sentinel-1/Sentinel-3 products. The public site asks people with legitimate access to contact the project without pretending such feeds are generally available.

## Source and project references

- [Production viewer](https://venn-fire.vercel.app)
- [Project README](../README.md)
- [Sentinel-2 analysis methodology](sentinel2-analysis.md)
- [Internal synchronized-source limit inventory](known-source-limits.md)

When speaking publicly, lead with the evidence separation, timestamps, and interpretation boundaries. The strongest claim is not that the viewer knows everything; it is that it preserves what each source actually said, makes derived logic reproducible, and avoids presenting one evidence type as another.
