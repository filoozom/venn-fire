import {
  FIRMS_SENSORS,
  FOOTPRINT_ESTIMATE_CAVEATS,
  buildFirmsRequests,
  detectionFootprint,
  meetsConfidence,
  parseFirmsCsv,
  summarizeSensorDetections,
} from '../src/firmsDetections.js'
import { loadDataset, setNoStoreHeaders } from '../server/database.mjs'

const DROSSART = { latitude: 50.54762, longitude: 6.05757 }
const INCIDENT_RADIUS_KM = 15
const BBOX = [5.85, 50.42, 6.3, 50.7]
const MINIMUM_CONFIDENCE = 'nominal'
const DAY_RANGE = 2
const CACHE_SECONDS = 15 * 60

function isoDateDaysAgo(nowMs, daysAgo) {
  return new Date(nowMs - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function haversineKm(latitude, longitude) {
  const radians = Math.PI / 180
  const deltaLatitude = (latitude - DROSSART.latitude) * radians
  const deltaLongitude = (longitude - DROSSART.longitude) * radians
  const value = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(DROSSART.latitude * radians) * Math.cos(latitude * radians) * Math.sin(deltaLongitude / 2) ** 2
  return 6371.0088 * 2 * Math.asin(Math.sqrt(value))
}

async function fetchCsv(request, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(request.url, {
      headers: { Accept: 'text/csv' },
      signal: AbortSignal.timeout(12_000),
    })
    const rawBody = await response.text()
    const base = {
      request,
      statusCode: response.status,
      contentType: response.headers.get('content-type') || 'text/csv',
      rawBody,
    }
    if (!response.ok) return { ...base, ok: false, error: `HTTP ${response.status}` }

    // FIRMS can return an invalid-key or quota message with HTTP 200.
    const header = rawBody.split(/\r?\n/, 1)[0]?.toLowerCase() ?? ''
    if (!header.includes('latitude') || !header.includes('longitude')) {
      return { ...base, ok: false, error: 'FIRMS did not return a CSV detection response' }
    }
    return { ...base, ok: true }
  } catch (error) {
    return {
      request,
      ok: false,
      statusCode: null,
      contentType: 'text/csv',
      rawBody: null,
      error: String(error?.message || error),
    }
  }
}

function publicSensorStatus(request, ok, detail = null, metadata = {}) {
  return {
    sensorKey: request.sensor.key,
    sensorName: request.sensor.name,
    ok,
    sourceRequestUrl: request.citableUrl,
    ...metadata,
    ...(detail ? { detail } : {}),
  }
}

export async function loadFirms({ mapKey, requestedAtMs, includeRaw = false, fetchImpl = fetch }) {
  const startDate = isoDateDaysAgo(requestedAtMs, DAY_RANGE - 1)
  const requests = buildFirmsRequests({
    mapKey,
    bbox: BBOX,
    startDate,
    dayRange: DAY_RANGE,
  })
  const results = await Promise.all(requests.map((request) => fetchCsv(request, fetchImpl)))

  const retrievedAt = new Date(requestedAtMs).toISOString()
  const sensors = []
  const detections = []
  const sources = []

  results.forEach((result) => {
    const { request } = result
    if (!result.ok) {
      sources.push(publicSensorStatus(request, false, result.error || 'Request failed', {
        statusCode: result.statusCode,
      }))
      return
    }

    const parsed = parseFirmsCsv(result.rawBody, request.sensor)
    const inRadius = parsed.detections.filter(
      (detection) => haversineKm(detection.latitude, detection.longitude) <= INCIDENT_RADIUS_KM,
    )
    const excludedOutsideRadius = parsed.detections.length - inRadius.length
    const summary = summarizeSensorDetections({
      sensor: request.sensor,
      detections: inRadius,
      skippedRows: parsed.skippedRows,
      requestUrl: request.citableUrl,
      retrievedAt,
      minimumConfidence: MINIMUM_CONFIDENCE,
      origin: DROSSART,
    })

    sensors.push({ ...summary, excludedOutsideRadius })
    detections.push(...inRadius.map((detection) => ({
      ...detection,
      footprint: detection.displayMode === 'centroid' ? null : detectionFootprint(detection),
      meetsMinimumConfidence: meetsConfidence(detection, MINIMUM_CONFIDENCE),
      providesArea: request.sensor.providesArea === true,
      displayMode: detection.displayMode ?? request.sensor.displayMode ?? 'footprint',
      pixelSizeLabel: request.sensor.pixelSizeLabel ?? `${request.sensor.nominalResolutionM} m nominal pixel`,
      areaExclusionReason: request.sensor.areaExclusionReason ?? null,
    })))
    sources.push(publicSensorStatus(request, true, null, {
      statusCode: result.statusCode,
      responseBytes: Buffer.byteLength(result.rawBody),
    }))
  })

  const latestAcquiredAt = detections.length
    ? detections.reduce((latest, detection) => (
        detection.acquiredAt > latest ? detection.acquiredAt : latest
      ), detections[0].acquiredAt)
    : null

  return {
    schemaVersion: 1,
    generatedAt: retrievedAt,
    incidentDate: startDate,
    dayRange: DAY_RANGE,
    bbox: {
      minLon: BBOX[0],
      minLat: BBOX[1],
      maxLon: BBOX[2],
      maxLat: BBOX[3],
    },
    locationReference: {
      name: 'Drossart locality (OpenStreetMap node 5770188072)',
      latitude: DROSSART.latitude,
      longitude: DROSSART.longitude,
      url: 'https://www.openstreetmap.org/node/5770188072',
    },
    radiusKm: INCIDENT_RADIUS_KM,
    minimumConfidence: MINIMUM_CONFIDENCE,
    currentWindowDetectionCount: detections.length,
    latestAcquiredAt,
    sensors,
    detections,
    sources,
    ...(includeRaw
      ? {
          rawResponses: results.map((result) => ({
            provider: {
              id: `firms-${result.request.sensor.key}`,
              name: result.request.sensor.name,
              website: 'https://firms.modaps.eosdis.nasa.gov/',
              endpoint: result.request.citableUrl,
            },
            ok: result.ok,
            statusCode: result.statusCode,
            contentType: result.contentType,
            rawBody: result.rawBody,
            error: result.error || null,
          })),
        }
      : {}),
    interpretation: [
      'Every coordinate is an exact NASA FIRMS detection centroid; no position is interpolated.',
      `Only detections within ${INCIDENT_RADIUS_KM} km of Drossart are returned.`,
      'A detection is a thermal anomaly at the moment of a polar overpass or geostationary scan, not a burned-area polygon.',
      'Per-sensor hectare values are footprint-union estimates and must never be added together.',
      'Only sensors with providesArea=true may expose a hectare estimate. MODIS and Meteosat are detections-only.',
      'GOES_NRT scan and track fields are not physical kilometre dimensions: Met12 supplies zeroes while MSG rows carry image-grid coordinates. Known platforms use an explicitly approximate ground footprint computed from native sampling, EUMETSAT service longitude and local viewing geometry; unknown platforms remain centroids.',
      ...FOOTPRINT_ESTIMATE_CAVEATS,
    ],
  }
}

export default async function handler(request, response) {
  setNoStoreHeaders(response)
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (request.method === 'OPTIONS') return response.status(204).end()
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' })

  try {
    const dataset = await loadDataset('firms')
    if (!dataset) throw new Error('FIRMS dataset has not been seeded')
    return response.status(200).json({
      ok: true,
      configured: Boolean(process.env.FIRMS_MAP_KEY?.trim()),
      refreshAfterSeconds: CACHE_SECONDS,
      ...dataset.payload,
      databaseRefreshedAt: dataset.refreshedAt,
    })
  } catch (error) {
    console.error('FIRMS database read failed:', error?.message || error)
    return response.status(503).json({
      ok: false,
      configured: Boolean(process.env.FIRMS_MAP_KEY?.trim()),
      generatedAt: new Date().toISOString(),
      refreshAfterSeconds: CACHE_SECONDS,
      sensors: [],
      detections: [],
      sources: [],
      error: 'FIRMS database read failed',
    })
  }
}
