import { databaseOverview, loadDatasets, setNoStoreHeaders } from '../server/database.mjs'

export const INCIDENT = { latitude: 50.54762, longitude: 6.05757 }
export const INCIDENT_AIRCRAFT = new Map([
  ['44c1e5', { callSign: 'G10', registration: 'OO-POE' }],
  ['44c1e8', { callSign: 'G12', registration: 'OO-POH' }],
  ['44c1ea', { callSign: 'G17', registration: 'OO-POJ' }],
])
export const INCIDENT_RADIUS_KM = 10
export const LIVE_REFRESH_SECONDS = 5 * 60

export const LIVE_AIRCRAFT_PROVIDERS = [
  {
    id: 'adsb-fi',
    name: 'adsb.fi',
    website: 'https://adsb.fi/',
    endpoint: `https://opendata.adsb.fi/api/v2/lat/${INCIDENT.latitude}/lon/${INCIDENT.longitude}/dist/25`,
  },
  {
    id: 'adsb-lol',
    name: 'ADSB.lol',
    website: 'https://www.adsb.lol/',
    endpoint: `https://api.adsb.lol/v2/point/${INCIDENT.latitude}/${INCIDENT.longitude}/25`,
  },
]

function haversineKm(latitude, longitude) {
  const radians = Math.PI / 180
  const deltaLatitude = (latitude - INCIDENT.latitude) * radians
  const deltaLongitude = (longitude - INCIDENT.longitude) * radians
  const value = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(INCIDENT.latitude * radians) * Math.cos(latitude * radians) * Math.sin(deltaLongitude / 2) ** 2
  return 6371.0088 * 2 * Math.asin(Math.sqrt(value))
}

async function fetchJsonResponse(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const rawBody = await response.text()
  return { payload: JSON.parse(rawBody), rawBody }
}

async function fetchJson(url) {
  return (await fetchJsonResponse(url)).payload
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function normalizeAircraft(payload, provider, requestedAtMs) {
  // Both providers publish the epoch represented by `seen_pos`. Using it keeps
  // an observation's timestamp stable when two consecutive imports receive the
  // same fix; falling back to our request time preserves compatibility with
  // provider responses that omit `now`.
  const payloadTimestampMs = finiteNumber(payload?.now)
  const referenceTimestampMs = payloadTimestampMs == null
    ? requestedAtMs
    : (payloadTimestampMs > 10_000_000_000 ? payloadTimestampMs : payloadTimestampMs * 1_000)

  return (payload?.ac || payload?.aircraft || []).flatMap((aircraft) => {
    const icao24 = String(aircraft.hex || aircraft.icao24 || '').trim().toLowerCase()
    const identity = INCIDENT_AIRCRAFT.get(icao24)
    if (!identity) return []

    const latitude = finiteNumber(aircraft.lat)
    const longitude = finiteNumber(aircraft.lon)
    if (latitude == null || longitude == null) return []
    const distanceDrossartKm = haversineKm(latitude, longitude)
    // This also rejects the known false MLAT cluster near Aachen/Walheim.
    if (distanceDrossartKm > INCIDENT_RADIUS_KM) return []

    const seenPositionSeconds = Math.max(0, finiteNumber(aircraft.seen_pos) ?? finiteNumber(aircraft.seen) ?? 0)
    const altitudeValue = aircraft.alt_baro === 'ground'
      ? 0
      : finiteNumber(aircraft.alt_baro) ?? finiteNumber(aircraft.alt_geom)

    return [{
      icao24,
      callSign: String(aircraft.flight || aircraft.callsign || identity.callSign).trim() || identity.callSign,
      registration: String(aircraft.r || aircraft.registration || identity.registration).trim() || identity.registration,
      observedAt: new Date(referenceTimestampMs - seenPositionSeconds * 1_000).toISOString(),
      latitude,
      longitude,
      altitudeFt: altitudeValue,
      groundSpeedKt: finiteNumber(aircraft.gs),
      trackDegrees: finiteNumber(aircraft.track),
      seenPositionSeconds,
      distanceDrossartKm,
      updateType: `${provider.name} live receiver observation`,
      providerId: provider.id,
      providerName: provider.name,
      providerUrl: provider.website,
    }]
  })
}

export async function loadAircraft(
  requestedAtMs,
  providers = LIVE_AIRCRAFT_PROVIDERS,
  { includeRaw = false } = {},
) {
  const results = await Promise.allSettled(providers.map(async (provider) => {
    const response = await fetchJsonResponse(provider.endpoint)
    return { provider, ...response }
  }))
  const sourceStatus = []
  const candidatesByHex = new Map()

  results.forEach((result, index) => {
    const provider = providers[index]
    if (result.status === 'rejected') {
      sourceStatus.push({ id: provider.id, name: provider.name, ok: false })
      return
    }
    sourceStatus.push({ id: provider.id, name: provider.name, ok: true })
    normalizeAircraft(result.value.payload, provider, requestedAtMs).forEach((aircraft) => {
      const candidates = candidatesByHex.get(aircraft.icao24) || []
      candidates.push(aircraft)
      candidatesByHex.set(aircraft.icao24, candidates)
    })
  })

  if (!sourceStatus.some((source) => source.ok)) {
    throw new Error('All live ADS-B providers failed')
  }

  const observations = []
  const conflicts = []
  candidatesByHex.forEach((candidates, icao24) => {
    candidates.sort((left, right) => left.seenPositionSeconds - right.seenPositionSeconds)
    const selected = candidates[0]
    const corroborating = candidates.slice(1)
    const incompatible = corroborating.find((candidate) => {
      const separationKm = haversineBetween(
        selected.latitude,
        selected.longitude,
        candidate.latitude,
        candidate.longitude,
      )
      return separationKm > 5
        && Math.abs(Date.parse(selected.observedAt) - Date.parse(candidate.observedAt)) < 60_000
    })
    if (incompatible) {
      conflicts.push({ icao24, providers: candidates.map((candidate) => candidate.providerId) })
      return
    }
    observations.push({
      ...selected,
      corroboratedBy: corroborating.map((candidate) => candidate.providerId),
    })
  })

  return {
    observations,
    conflicts,
    sources: sourceStatus,
    ...(includeRaw
      ? {
          rawResponses: results.flatMap((result) => (
            result.status === 'fulfilled'
              ? [{
                  provider: result.value.provider,
                  payload: result.value.payload,
                  rawBody: result.value.rawBody,
                }]
              : []
          )),
        }
      : {}),
  }
}

function haversineBetween(leftLatitude, leftLongitude, rightLatitude, rightLongitude) {
  const radians = Math.PI / 180
  const deltaLatitude = (rightLatitude - leftLatitude) * radians
  const deltaLongitude = (rightLongitude - leftLongitude) * radians
  const value = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(leftLatitude * radians) * Math.cos(rightLatitude * radians) * Math.sin(deltaLongitude / 2) ** 2
  return 6371.0088 * 2 * Math.asin(Math.sqrt(value))
}

export async function loadWeather() {
  const parameters = new URLSearchParams({
    latitude: String(INCIDENT.latitude),
    longitude: String(INCIDENT.longitude),
    hourly: 'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    current: 'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    timezone: 'UTC',
    past_days: '2',
    forecast_days: '2',
  })
  const payload = await fetchJson(`https://api.open-meteo.com/v1/forecast?${parameters}`)
  const hourly = payload.hourly || {}
  const rows = (hourly.time || []).map((time, index) => ({
    observedAt: new Date(`${time}Z`).toISOString(),
    timestampMs: Date.parse(`${time}Z`),
    temperature: finiteNumber(hourly.temperature_2m?.[index]),
    humidity: finiteNumber(hourly.relative_humidity_2m?.[index]),
    windSpeed: finiteNumber(hourly.wind_speed_10m?.[index]),
    windDirection: finiteNumber(hourly.wind_direction_10m?.[index]),
    gust: finiteNumber(hourly.wind_gusts_10m?.[index]),
    source: 'Open-Meteo hourly model',
  })).filter((row) => [row.temperature, row.humidity, row.windSpeed, row.windDirection, row.gust].every(Number.isFinite))

  const current = payload.current ? {
    observedAt: new Date(`${payload.current.time}Z`).toISOString(),
    temperature: finiteNumber(payload.current.temperature_2m),
    humidity: finiteNumber(payload.current.relative_humidity_2m),
    windSpeed: finiteNumber(payload.current.wind_speed_10m),
    windDirection: finiteNumber(payload.current.wind_direction_10m),
    gust: finiteNumber(payload.current.wind_gusts_10m),
  } : null

  return { rows, current }
}

export default async function handler(request, response) {
  setNoStoreHeaders(response)
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (request.method === 'OPTIONS') return response.status(204).end()
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' })

  try {
    const [datasets, database] = await Promise.all([loadDatasets(), databaseOverview()])
    const weather = datasets['weather-open-meteo']?.payload
    const aircraft = datasets.aircraft?.payload
    const reports = datasets.reports?.payload
    return response.status(200).json({
      schemaVersion: 3,
      generatedAt: new Date().toISOString(),
      refreshAfterSeconds: LIVE_REFRESH_SECONDS,
      weather: weather
        ? { ok: true, rows: weather.rows || [], current: weather.current || null }
        : { ok: false, rows: [], current: null },
      aircraft: {
        ok: Boolean(aircraft),
        observations: aircraft?.observations || [],
        latestObservations: aircraft?.latestObservations || [],
        conflicts: aircraft?.conflicts || [],
        sources: aircraft?.sources || [],
        persistence: {
          configured: true,
          ok: Boolean(aircraft),
          historyObservationCount: aircraft?.observations?.length || 0,
          retentionPolicy: aircraft?.retentionPolicy || 'incident lifetime',
        },
      },
      reports: reports || { ok: false, complete: false, areaReports: [], sources: [] },
      database,
      interpretation: [
        'This endpoint reads Postgres only; provider polling is performed by the leased five-minute refresh function.',
        'Responses are not stored in the browser or Vercel CDN cache.',
      ],
    })
  } catch (error) {
    console.error('Live database read failed:', error?.message || error)
    return response.status(503).json({
      schemaVersion: 3,
      generatedAt: new Date().toISOString(),
      refreshAfterSeconds: LIVE_REFRESH_SECONDS,
      weather: { ok: false, rows: [], current: null },
      aircraft: { ok: false, observations: [], conflicts: [], sources: [], persistence: { configured: true, ok: false } },
      reports: { ok: false, complete: false, areaReports: [], sources: [] },
      error: 'Database read failed',
    })
  }
}
