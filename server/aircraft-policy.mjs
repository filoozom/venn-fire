export const EXCLUDED_INCIDENT_AIRCRAFT = new Map([
  ['44da74', {
    callSign: 'OOVST',
    registration: 'OO-VST',
    reason: 'Tecnam P2006T seen near the incident without response-specific aircraft, callsign or operational evidence',
  }],
  ['06a30b', {
    callSign: 'QTR8098',
    registration: 'A7-BFX',
    reason: 'Qatar Airways Boeing 777 transit traffic; cross-provider position agreement is not incident involvement',
  }],
])

export function excludedIncidentAircraft(icao24) {
  return EXCLUDED_INCIDENT_AIRCRAFT.get(String(icao24 || '').trim().toLowerCase()) ?? null
}

export function isExcludedIncidentAircraft(aircraft) {
  return Boolean(excludedIncidentAircraft(aircraft?.icao24 || aircraft?.hex || aircraft))
}
