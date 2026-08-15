const INCIDENT = { latitude: 50.54762, longitude: 6.05757 }
const INCIDENT_AIRCRAFT = new Map([
  ['44c1e5', { callSign: 'G10', registration: 'OO-POE' }],
  ['44c1e8', { callSign: 'G12', registration: 'OO-POH' }],
  ['44c1ea', { callSign: 'G17', registration: 'OO-POJ' }],
])
const INCIDENT_RADIUS_KM = 10

function haversineKm(latitude, longitude) {
  const radians = Math.PI / 180
  const deltaLatitude = (latitude - INCIDENT.latitude) * radians
  const deltaLongitude = (longitude - INCIDENT.longitude) * radians
  const value = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(INCIDENT.latitude * radians) * Math.cos(latitude * radians) * Math.sin(deltaLongitude / 2) ** 2
  return 6371.0088 * 2 * Math.asin(Math.sqrt(value))
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizeAircraft(payload, provider, requestedAtMs) {
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
      observedAt: new Date(requestedAtMs - seenPositionSeconds * 1_000).toISOString(),
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

async function loadAircraft(requestedAtMs) {
  const providers = [
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

  const results = await Promise.allSettled(providers.map(async (provider) => ({
    provider,
    payload: await fetchJson(provider.endpoint),
  })))
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

  return { observations, conflicts, sources: sourceStatus }
}

function haversineBetween(leftLatitude, leftLongitude, rightLatitude, rightLongitude) {
  const radians = Math.PI / 180
  const deltaLatitude = (rightLatitude - leftLatitude) * radians
  const deltaLongitude = (rightLongitude - leftLongitude) * radians
  const value = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(leftLatitude * radians) * Math.cos(rightLatitude * radians) * Math.sin(deltaLongitude / 2) ** 2
  return 6371.0088 * 2 * Math.asin(Math.sqrt(value))
}

async function loadWeather() {
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
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  response.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
  if (request.method === 'OPTIONS') return response.status(204).end()
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' })

  const requestedAtMs = Date.now()
  const [weatherResult, aircraftResult] = await Promise.allSettled([
    loadWeather(),
    loadAircraft(requestedAtMs),
  ])

  return response.status(200).json({
    schemaVersion: 1,
    generatedAt: new Date(requestedAtMs).toISOString(),
    refreshAfterSeconds: 60,
    weather: weatherResult.status === 'fulfilled'
      ? { ok: true, ...weatherResult.value }
      : { ok: false, rows: [], current: null },
    aircraft: aircraftResult.status === 'fulfilled'
      ? { ok: true, ...aircraftResult.value }
      : { ok: false, observations: [], conflicts: [], sources: [] },
    interpretation: [
      'Aircraft coordinates are exact current receiver observations from one selected provider; provider positions are never averaged.',
      'Only known incident aircraft within 10 km of Drossart are returned, excluding the known Aachen/Walheim MLAT artifact.',
      'Absence from this response is not proof that an aircraft did not fly.',
      'Open-Meteo values are model output, not readings from an incident weather station.',
    ],
  })
}
