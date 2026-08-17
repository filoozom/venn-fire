import { isExcludedIncidentAircraft } from './aircraft-policy.mjs'

export const PUBLIC_DATASET_KEYS = Object.freeze([
  'aircraft',
  'effis',
  'ems',
  'firms',
  'incident-config',
  'media-reports',
  'local-authority-updates',
  'official-perimeter',
  'public-alerts',
  'public-operations',
  'reports',
  'road-events',
  'sentinel2',
  'source-registry',
  'weather-dwd',
  'weather-open-meteo',
  'weather-rmi',
])

const PUBLIC_DATASET_KEY_SET = new Set(PUBLIC_DATASET_KEYS)

function definedFields(value, fields) {
  return Object.fromEntries(fields.flatMap((field) => (
    value?.[field] == null ? [] : [[field, value[field]]]
  )))
}

function compactAircraft(payload) {
  const compactObservation = (observation) => definedFields(observation, [
    'icao24',
    'callSign',
    'registration',
    'observedAt',
    'latitude',
    'longitude',
    'altitudeFt',
    'updateType',
    'providerUrl',
    'aircraftType',
    'aircraftDescription',
    'displayType',
    'selectionBasis',
    'candidateEvidence',
    'routeScope',
  ])
  return {
    ...payload,
    observations: (payload.observations ?? [])
      .filter((observation) => !isExcludedIncidentAircraft(observation))
      .map(compactObservation),
    latestObservations: (payload.latestObservations ?? [])
      .filter((observation) => !isExcludedIncidentAircraft(observation))
      .map(compactObservation),
  }
}

function compactFirms(payload) {
  return {
    ...payload,
    detections: (payload.detections ?? []).map((detection) => definedFields(detection, [
      'frpMw',
      'scanKm',
      'trackKm',
      'latitude',
      'longitude',
      'satellite',
      'sensorKey',
      'acquiredAt',
      'confidence',
      'displayMode',
      'footprintSource',
      'footprintBearingDeg',
      'subSatelliteLongitude',
    ])),
  }
}

export function publicDatasetPayload(key, payload) {
  if (!PUBLIC_DATASET_KEY_SET.has(key)) return null
  if (!payload || typeof payload !== 'object') return payload
  if (key === 'aircraft') return compactAircraft(payload)
  if (key === 'firms') return compactFirms(payload)
  return payload
}
