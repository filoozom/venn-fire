# Known limits that are not synchronized

This is internal implementation documentation. Do not render this list in the public viewer or serialize it through public API responses.

| Key | Status | Detail |
| --- | --- | --- |
| `aircraft-receiver-visibility` | `inherent-source-limit` | ADS-B/MLAT can miss aircraft with no public transponder position, poor receiver coverage or an observation outside the ten-kilometre incident filter. Candidate status establishes proximity only, not an assigned firefighting role. |
| `walloon-live-road-events` | `access-not-supplied` | The official DATEX II adapter is ready, but no provider credentials or authenticated agency push has been supplied. |
| `field-confirmed-fire-perimeter` | `access-not-supplied` | No fire-service or crisis-centre GeoJSON perimeter feed/export has been supplied to the ready pull/push adapter. |
| `sanitized-suppression-operations` | `access-not-supplied` | No agency-approved dispatch, water pickup/drop, closure, evacuation or aggregate-compliance feed/export has been supplied. |
| `historical-be-alert-before-collection` | `not-reconstructable-from-live-feed` | Alerts that expired before collection began are absent unless an external archive is supplied. |
| `sentinel-analysis-ready-imagery` | `credentials-required` | Public quicklooks are retained; clipped multispectral bands and derived burn products require Copernicus Data Space OAuth credentials. |
| `raw-cad-and-radio` | `not-public-and-potentially-sensitive` | Raw dispatch/CAD and tactical radio traffic are not published. Only an agency-approved sanitized export will be ingested. |
| `evacuation-compliance-identities` | `intentionally-excluded` | Personal-level compliance data must not be exposed; the adapter accepts agency-approved aggregate counts only. |
