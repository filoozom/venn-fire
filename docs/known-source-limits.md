# Known limits that are not synchronized

This is internal implementation documentation. Do not render this list in the public viewer or serialize it through public API responses.

| Key | Status | Detail |
| --- | --- | --- |
| `aircraft-receiver-visibility` | `inherent-source-limit` | ADS-B/MLAT can miss aircraft with no public transponder position, poor receiver coverage or an observation outside the ten-kilometre incident filter. Candidate status establishes proximity only, not an assigned firefighting role. |
| `sentinel-cloud-obstruction` | `inherent-source-limit` | Public L2A COG windows now supply B8A, B12 and SCL for the derived dNBR product. Cloud, cirrus, smoke, shadow and classification uncertainty still leave obscured pixels unknown; missing change cannot be interpreted as unburned ground. |
