import { isExcludedIncidentAircraft } from './aircraft-policy.mjs'

export const PUBLIC_DATASET_KEYS = Object.freeze([
  'aircraft',
  'effis',
  'ems',
  'firms',
  'incident-config',
  'media-reports',
  'local-authority-updates',
  'public-alerts',
  'reports',
  'sentinel2',
  'source-registry',
  'weather-dwd',
  'weather-open-meteo',
  'weather-rmi',
])

const PUBLIC_DATASET_KEY_SET = new Set(PUBLIC_DATASET_KEYS)
const PRIVATE_REGISTRY_SOURCE_KEYS = new Set([
  'aircraft-artifacts',
  'aircraft-traces',
  'aircraft-history',
  'aircraft-route-history',
  'firms-history',
  'effis-history-migration',
  'road-events',
  'official-perimeter',
  'public-operations',
])

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

function compactSourceRegistry(payload) {
  const { coverageGaps: _internalCoverageGaps, ...publicPayload } = payload
  return {
    ...publicPayload,
    sources: (payload.sources ?? [])
      .filter((source) => !PRIVATE_REGISTRY_SOURCE_KEYS.has(source.key))
      .map(({ access: _privateAccess, directory: _privateDirectory, ...source }) => source),
  }
}

function compactSentinel2(payload) {
  const compactQuicklook = (quicklook) => quicklook == null ? null : definedFields(quicklook, [
    'stored',
    'databaseUrl',
    'providerUrl',
    'contentType',
    'byteLength',
    'error',
  ])
  const compactScene = (scene) => scene == null ? null : {
    ...scene,
    quicklook: compactQuicklook(scene.quicklook),
  }
  const compactAnalysis = (analysis) => {
    const { sourceRasterArtifactKey: _internalArtifactKey, ...publicAnalysis } = analysis
    return publicAnalysis
  }
  return {
    ...payload,
    scenes: (payload.scenes ?? []).map(compactScene),
    lastPreFireScene: compactScene(payload.lastPreFireScene),
    firstPostFireScene: compactScene(payload.firstPostFireScene),
    analyses: (payload.analyses ?? []).map(compactAnalysis),
  }
}

export function publicDatasetPayload(key, payload) {
  if (!PUBLIC_DATASET_KEY_SET.has(key)) return null
  if (!payload || typeof payload !== 'object') return payload
  if (key === 'aircraft') return compactAircraft(payload)
  if (key === 'firms') return compactFirms(payload)
  if (key === 'sentinel2') return compactSentinel2(payload)
  if (key === 'source-registry') return compactSourceRegistry(payload)
  return payload
}
