import {
  FIRMS_SENSORS,
  FOOTPRINT_ESTIMATE_CAVEATS,
  buildFirmsRequests,
  detectionFootprint,
  meetsConfidence,
  parseFirmsCsv,
  summarizeSensorDetections,
} from '../src/firmsDetections.js'

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

async function fetchCsv(url) {
  const response = await fetch(url, {
    headers: { Accept: 'text/csv' },
    signal: AbortSignal.timeout(12_000),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  // FIRMS can return an invalid-key or quota message with HTTP 200.
  const header = body.split(/\r?\n/, 1)[0]?.toLowerCase() ?? ''
  if (!header.includes('latitude') || !header.includes('longitude')) {
    throw new Error('FIRMS did not return a CSV detection response')
  }
  return body
}

function publicSensorStatus(request, ok, detail = null) {
  return {
    sensorKey: request.sensor.key,
    sensorName: request.sensor.name,
    ok,
    sourceRequestUrl: request.citableUrl,
    ...(detail ? { detail } : {}),
  }
}

async function loadFirms({ mapKey, requestedAtMs }) {
  const startDate = isoDateDaysAgo(requestedAtMs, DAY_RANGE - 1)
  const requests = buildFirmsRequests({
    mapKey,
    bbox: BBOX,
    startDate,
    dayRange: DAY_RANGE,
  })
  const results = await Promise.allSettled(requests.map(async (request) => ({
    request,
    csv: await fetchCsv(request.url),
  })))

  const retrievedAt = new Date(requestedAtMs).toISOString()
  const sensors = []
  const detections = []
  const sources = []

  results.forEach((result, index) => {
    const request = requests[index]
    if (result.status === 'rejected') {
      sources.push(publicSensorStatus(request, false, result.reason?.message || 'Request failed'))
      return
    }

    const parsed = parseFirmsCsv(result.value.csv, request.sensor)
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
      footprint: detectionFootprint(detection),
      meetsMinimumConfidence: meetsConfidence(detection, MINIMUM_CONFIDENCE),
    })))
    sources.push(publicSensorStatus(request, true))
  })

  if (!sensors.length) throw new Error('Every FIRMS sensor request failed')

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
    sensors,
    detections,
    sources,
    interpretation: [
      'Every coordinate is an exact NASA FIRMS detection centroid; no position is interpolated.',
      `Only detections within ${INCIDENT_RADIUS_KM} km of Drossart are returned.`,
      'A detection is a thermal anomaly at the moment of overpass, not a burned-area polygon.',
      'Per-sensor hectare values are footprint-union estimates and must never be added together.',
      'MODIS pixels are too coarse for an area figure at this incident scale; clients must suppress its hectare estimate.',
      ...FOOTPRINT_ESTIMATE_CAVEATS,
    ],
  }
}

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  response.setHeader(
    'Cache-Control',
    `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS * 4}`,
  )
  if (request.method === 'OPTIONS') return response.status(204).end()
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' })

  const requestedAtMs = Date.now()
  const mapKey = process.env.FIRMS_MAP_KEY?.trim()
  if (!mapKey) {
    return response.status(200).json({
      ok: false,
      configured: false,
      generatedAt: new Date(requestedAtMs).toISOString(),
      refreshAfterSeconds: CACHE_SECONDS,
      sensors: [],
      detections: [],
      sources: FIRMS_SENSORS.map((sensor) => ({
        sensorKey: sensor.key,
        sensorName: sensor.name,
        ok: false,
      })),
      error: 'Server-side NASA FIRMS refresh is not configured; use the bundled audited snapshot.',
    })
  }

  try {
    const payload = await loadFirms({ mapKey, requestedAtMs })
    return response.status(200).json({
      ok: true,
      configured: true,
      refreshAfterSeconds: CACHE_SECONDS,
      ...payload,
    })
  } catch {
    return response.status(200).json({
      ok: false,
      configured: true,
      generatedAt: new Date(requestedAtMs).toISOString(),
      refreshAfterSeconds: CACHE_SECONDS,
      sensors: [],
      detections: [],
      sources: [],
      error: 'NASA FIRMS refresh failed; use the bundled audited snapshot.',
    })
  }
}
