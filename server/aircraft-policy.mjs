export const EXCLUDED_INCIDENT_AIRCRAFT = new Map([
  ['44da74', {
    callSign: 'OOVST',
    registration: 'OO-VST',
    reason: 'Tecnam P2006T seen near the incident without response-specific aircraft, callsign or operational evidence',
  }],
])

export function excludedIncidentAircraft(icao24) {
  return EXCLUDED_INCIDENT_AIRCRAFT.get(String(icao24 || '').trim().toLowerCase()) ?? null
}

export function isExcludedIncidentAircraft(aircraft) {
  return Boolean(excludedIncidentAircraft(aircraft?.icao24 || aircraft?.hex || aircraft))
}
