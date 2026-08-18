# Known limits that are not synchronized

This is internal implementation documentation. Do not render this list in the public viewer or serialize it through public API responses.

| Key | Status | Detail |
| --- | --- | --- |
| `aircraft-receiver-visibility` | `inherent-source-limit` | ADS-B/MLAT can miss aircraft with no public transponder position, poor receiver coverage or an observation outside the ten-kilometre incident filter. Candidate status establishes proximity only, not an assigned firefighting role. |
| `sentinel-cloud-obstruction` | `inherent-source-limit` | Public L2A COG windows now supply B8A, B12 and SCL for the derived dNBR product. Cloud, cirrus, smoke, shadow and classification uncertainty still leave obscured pixels unknown; missing change cannot be interpreted as unburned ground. |
| `sentinel-1-public-pixels` | `provider-access-limit` | The public CDSE STAC catalogue and thumbnails are synchronized. The catalogue's GRD measurement COGs are advertised through authenticated object storage; thumbnails are not georeferenced/calibrated change rasters, so matched acquisitions remain corroboration candidates and never modify the Best estimate. |
| `sentinel-3-public-frp-rows` | `provider-access-limit` | The public CDSE STAC catalogue and thumbnails are synchronized. Coordinate-level SWIR/MWIR FRP CSV/NetCDF assets are advertised through authenticated object storage. Catalogue intersection and a swath preview are not converted into local detections. |
| `rmi-public-radar-resolution` | `inherent-source-limit` | RMI's public website animation is accessible and retained, but currently publishes categorical images at ten-minute timestamps. Its advertised open-data WMS capabilities are readable while map requests return HTTP 403. The implementation uses the working official public animation and does not claim millimetre values. |
| `gibs-visual-only` | `inherent-source-limit` | GIBS corrected-reflectance imagery is daily visual context. It does not expose a local hotspot measurement, acquisition time for every contributing granule, or a burned-area edge in the cropped image response. |
| `cams-model-not-observation` | `inherent-source-limit` | CAMS wildfire PM10 and PM2.5 values are hourly 0.1° ensemble model-grid forecasts, not local ground-sensor observations. Wildfire-only PM10 is experimental and the public WMS colour style saturates at 500 µg/m³. Exact provider values are retained separately; both products indicate possible transport and never alter fire geometry. |
