# Sentinel-2 burn-change analysis

This is internal implementation documentation. The public viewer should expose the evidence, acquisition time and scientific caveats, but not operational configuration or credential notes.

## Sources and cadence

- The Copernicus Data Space OData catalogue remains the authoritative scene-discovery record and supplies the retained public JPEG quicklooks.
- Public Sentinel-2 Collection 1 L2A Cloud-Optimized GeoTIFFs are discovered through [Element 84 Earth Search](https://github.com/Element84/earth-search) and read from the [AWS Open Data Sentinel-2 COG archive](https://registry.opendata.aws/sentinel-2-l2a-cogs/).
- The Vercel scheduler checks both catalogues every five minutes. Multispectral pixels are downloaded and processed only when a previously unseen post-fire scene appears.
- The incident crop uses tile `T31UGS`, EPSG:32631 and WGS84 bounds `[5.88, 50.42, 6.23, 50.68]`.

## Inputs and selection

- Pre-fire reference: the newest L2A scene before the reported ignition time.
- Post-fire observation: each newly available L2A scene after ignition.
- Bands: B8A near infrared and B12 short-wave infrared at 20 m, plus the 20 m Scene Classification Layer (SCL).
- Only SCL classes 4 (vegetation) and 5 (not vegetated) are accepted in both scenes. No-data, shadows, water, unclassified pixels, cloud, cirrus and snow are excluded.
- The reflectance scale and offset published on each STAC asset are applied before calculating NBR.

## Qualification rule

`NBR = (B8A - B12) / (B8A + B12)` and `dNBR = pre-fire NBR - post-fire NBR`.

A 20 m pixel is eligible when dNBR is at least 0.15 and its centre is within 750 m of an independently corroborated VIIRS fire-core observation acquired by the post-fire scene time. Eligible pixels enter the shared 50 m estimate grid only when:

1. at least two eligible 20 m pixels land in that 50 m cell;
2. at least one has dNBR of 0.20 or greater; and
3. the cell belongs to a four-neighbour component containing at least four cells.

The accepted cells are dissolved into a MultiPolygon for the purple map layer. The same integer cell coordinates are inserted directly into the existing 50 m Best estimate union. Sentinel evidence may add positive support but never removes thermal or aircraft evidence, because cloud or absent spectral change cannot establish that ground was unburned.

## PostgreSQL retention

Each unique official catalogue response and Earth Search response is retained as a content-addressed JSON artifact. For every processed post-fire scene, the exact clipped digital-number arrays are stored once as a gzip artifact named `sentinel2-analysis-raster-<scene-id>`.

The uncompressed raster artifact format is:

1. one UTF-8 JSON header line ending in `\n`;
2. raw arrays in this order: pre B8A, pre B12, pre SCL, post B8A, post B12, post SCL.

The header records dimensions, UTM window and transform, typed-array names, byte lengths, source URLs, band scale/offset metadata and both scene identifiers. Dataset versions retain the derived statistics, 50 m cell coordinates, dissolved geometry, thresholds and artifact key.

## Interpretation

Positive dNBR is spectral change consistent with fire effects; it is not a field-confirmed perimeter or a locally calibrated severity class. Cloud, smoke, shadow and SCL uncertainty can leave most of a scene unobserved. The viewer therefore reports the clear fraction and treats obscured pixels as unknown.

