import { databaseOverview, loadPublicDatasets, setNoStoreHeaders } from '../server/database.mjs'
import { isExcludedIncidentAircraft } from '../server/aircraft-policy.mjs'

export const INCIDENT = { latitude: 50.54762, longitude: 6.05757 }
export const INCIDENT_AIRCRAFT = new Map([
  ['44c1e5', { callSign: 'G10', registration: 'OO-POE', displayType: 'helicopter' }],
  ['44c1e8', { callSign: 'G12', registration: 'OO-POH', displayType: 'helicopter' }],
  ['44c1ea', { callSign: 'G17', registration: 'OO-POJ', displayType: 'helicopter' }],
  ['480849', {
    callSign: 'GRZLY81',
    registration: 'D-472',
    aircraftType: 'H47',
    aircraftDescription: 'Boeing CH-47F Chinook',
    displayType: 'helicopter',
  }],
  ['48044a', {
    callSign: 'GRZLY80',
    callSignAliases: ['GRZLY91'],
    registration: 'D-604',
    aircraftType: 'H47',
    aircraftDescription: 'Boeing CH-47F Chinook',
    displayType: 'helicopter',
  }],
  ['480440', {
    callSign: 'GRZLY81',
    registration: 'D-479',
    aircraftType: 'H47',
    aircraftDescription: 'Boeing CH-47F Chinook',
    displayType: 'helicopter',
  }],
  ['48044c', {
    callSign: 'GRZLY80',
    registration: 'D-606',
    aircraftType: 'H47',
    aircraftDescription: 'Boeing CH-47F Chinook',
    displayType: 'helicopter',
  }],
  ['480444', {
    callSign: 'GRZLY80',
    registration: 'D-483',
    aircraftType: 'H47',
    aircraftDescription: 'Boeing CH-47F Chinook',
    displayType: 'helicopter',
  }],
])
export const INCIDENT_CALLSIGN_PATTERNS = [/^GRZLY\d{1,3}$/i]
export const INCIDENT_RADIUS_KM = 10
export const AIRCRAFT_DISCOVERY_RADIUS_NM = 10
export const LIVE_REFRESH_SECONDS = 5 * 60
export const INCIDENT_CANDIDATE_MAX_ALTITUDE_FT = 8_500
export const INCIDENT_CANDIDATE_MAX_SPEED_KT = 250
export const INCIDENT_CANDIDATE_MAX_POSITION_AGE_SECONDS = 120
export const INCIDENT_CANDIDATE_SESSION_GAP_MS = 30 * 60 * 1_000
const INCIDENT_POINT_PATH = `point/${INCIDENT.latitude}/${INCIDENT.longitude}/${AIRCRAFT_DISCOVERY_RADIUS_NM}`

const FIRE_RESPONSE_AIRCRAFT_TYPE_PATTERN = /^(?:AT8T|AT8|CL2T|CL21|CL215|CL41|CL415|H47|CH47)$/iu
const FIRE_RESPONSE_DESCRIPTION_PATTERN = /air\s*tractor|fire\s*boss|water\s*bomb|firefight|helicopter|helicopt[eè]re|hubschrauber|chinook|super\s*puma|cougar/iu
const ROTORCRAFT_TYPE_PATTERN = /^(?:H47|CH47|EC\d{2}|H\d{3}|AS\d{2}|S\d{2}|UH\d{2}|NH90|BK17)$/iu

export const LIVE_AIRCRAFT_PROVIDERS = [
  {
    id: 'adsb-fi',
    name: 'adsb.fi',
    website: 'https://adsb.fi/',
    endpoint: `https://opendata.adsb.fi/api/v3/lat/${INCIDENT.latitude}/lon/${INCIDENT.longitude}/dist/${AIRCRAFT_DISCOVERY_RADIUS_NM}`,
    intervalMinutes: 5,
  },
  {
    id: 'adsb-lol',
    name: 'ADSB.lol',
    website: 'https://www.adsb.lol/',
    endpoint: `https://api.adsb.lol/v2/${INCIDENT_POINT_PATH}`,
    intervalMinutes: 5,
  },
  {
    id: 'airplanes-live',
    name: 'Airplanes.live',
    website: 'https://airplanes.live/',
    endpoint: `https://api.airplanes.live/v2/${INCIDENT_POINT_PATH}`,
    // Their public endpoint currently rejects server traffic. Retain a regular
    // health check without spending the free tier's 500 daily requests on the
    // same HTTP 403 every five minutes.
    intervalMinutes: 60,
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

export function incidentDistanceKm(latitude, longitude) {
  return haversineKm(latitude, longitude)
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

function providerDue(provider, requestedAtMs) {
  const intervalMinutes = Number(provider.intervalMinutes) || 5
  if (intervalMinutes <= 5) return true
  const intervalBuckets = Math.max(1, Math.round(intervalMinutes / 5))
  return Math.floor(requestedAtMs / (5 * 60 * 1_000)) % intervalBuckets === 0
}

async function fetchAircraftProvider(provider) {
  try {
    const response = await fetch(provider.endpoint, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    const rawBody = await response.text()
    const contentType = response.headers.get('content-type') || 'application/octet-stream'
    if (!response.ok) {
      return {
        provider,
        polled: true,
        ok: false,
        statusCode: response.status,
        contentType,
        rawBody,
        error: `HTTP ${response.status}`,
      }
    }
    try {
      return {
        provider,
        polled: true,
        ok: true,
        statusCode: response.status,
        contentType,
        rawBody,
        payload: JSON.parse(rawBody),
      }
    } catch {
      return {
        provider,
        polled: true,
        ok: false,
        statusCode: response.status,
        contentType,
        rawBody,
        error: 'Invalid JSON response',
      }
    }
  } catch (error) {
    return {
      provider,
      polled: true,
      ok: false,
      statusCode: null,
      contentType: 'application/json',
      rawBody: null,
      error: String(error?.message || error),
    }
  }
}

function finiteNumber(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function cleanText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function trackedAircraftIdentityMap(trackedAircraft = []) {
  const identities = new Map(
    [...INCIDENT_AIRCRAFT].map(([icao24, identity]) => [icao24, {
      ...identity,
      selectionBasis: 'verified-icao24',
    }]),
  )
  for (const aircraft of trackedAircraft || []) {
    const icao24 = cleanText(aircraft?.icao24 || aircraft?.hex)?.toLowerCase()
    if (!icao24 || !/^[0-9a-f]{6}$/.test(icao24)) continue
    const existing = identities.get(icao24) || {}
    identities.set(icao24, {
      ...existing,
      callSign: cleanText(aircraft.callSign || aircraft.flight) || existing.callSign || icao24.toUpperCase(),
      registration: cleanText(aircraft.registration || aircraft.r) || existing.registration || null,
      aircraftType: cleanText(aircraft.aircraftType || aircraft.t) || existing.aircraftType || null,
      aircraftDescription: cleanText(aircraft.aircraftDescription || aircraft.desc)
        || existing.aircraftDescription
        || null,
      displayType: cleanText(aircraft.displayType) || existing.displayType || null,
      selectionBasis: existing.selectionBasis
        || cleanText(aircraft.selectionBasis)
        || 'retained-incident-history',
    })
  }
  return identities
}

function aircraftDisplayType(aircraft) {
  const category = cleanText(aircraft?.category)?.toUpperCase()
  const aircraftType = cleanText(aircraft?.t || aircraft?.aircraftType)
  const description = cleanText(aircraft?.desc || aircraft?.aircraftDescription)
  return category === 'A7'
    || ROTORCRAFT_TYPE_PATTERN.test(aircraftType || '')
    || /helicopter|helicopt[eè]re|hubschrauber|rotorcraft|chinook|super\s*puma|cougar/iu.test(description || '')
    ? 'helicopter'
    : 'plane'
}

function candidateEvidence(aircraft) {
  const category = cleanText(aircraft?.category)?.toUpperCase()
  const aircraftType = cleanText(aircraft?.t || aircraft?.aircraftType)
  const description = cleanText(aircraft?.desc || aircraft?.aircraftDescription)
  const dbFlags = finiteNumber(aircraft?.dbFlags)
  return [
    category === 'A7' ? 'rotorcraft-category' : null,
    FIRE_RESPONSE_AIRCRAFT_TYPE_PATTERN.test(aircraftType || '') ? 'fire-response-type' : null,
    FIRE_RESPONSE_DESCRIPTION_PATTERN.test(description || '') ? 'response-description' : null,
    dbFlags != null && (dbFlags & 1) === 1 ? 'military-database-flag' : null,
  ].filter(Boolean)
}

function plausibleIncidentCandidate(aircraft, distanceDrossartKm) {
  if (!Number.isFinite(distanceDrossartKm) || distanceDrossartKm > INCIDENT_RADIUS_KM) return false
  const seenPositionSeconds = Math.max(0, finiteNumber(aircraft?.seen_pos) ?? finiteNumber(aircraft?.seen) ?? 0)
  if (seenPositionSeconds > INCIDENT_CANDIDATE_MAX_POSITION_AGE_SECONDS) return false
  const altitudeFt = aircraft?.alt_baro === 'ground'
    ? 0
    : finiteNumber(aircraft?.alt_baro) ?? finiteNumber(aircraft?.alt_geom)
  if (altitudeFt != null && altitudeFt > INCIDENT_CANDIDATE_MAX_ALTITUDE_FT) return false
  const groundSpeedKt = finiteNumber(aircraft?.gs)
  if (groundSpeedKt != null && groundSpeedKt > INCIDENT_CANDIDATE_MAX_SPEED_KT) return false
  return true
}

export function resolveIncidentAircraft(
  aircraft,
  identities = INCIDENT_AIRCRAFT,
  { allowCandidate = false } = {},
) {
  const icao24 = cleanText(aircraft?.hex || aircraft?.icao24)?.toLowerCase()
  if (!icao24 || !/^[0-9a-f]{6}$/.test(icao24)) return null
  // Exact reviewed exclusions override both automatic proximity promotion and
  // identities retained by an earlier dataset version. Raw poll artifacts stay
  // in Postgres for audit; they are simply not presented as incident aircraft.
  if (isExcludedIncidentAircraft(icao24)) return null
  const callSign = cleanText(aircraft.flight || aircraft.callsign || aircraft.callSign)
  const known = identities.get(icao24)
  if (known) {
    return {
      ...known,
      icao24,
      callSign: callSign || known.callSign,
      registration: cleanText(aircraft.r || aircraft.registration) || known.registration || null,
      aircraftType: cleanText(aircraft.t || aircraft.aircraftType) || known.aircraftType || null,
      aircraftDescription: cleanText(aircraft.desc || aircraft.aircraftDescription)
        || known.aircraftDescription
        || null,
      selectionBasis: known.selectionBasis || 'verified-icao24',
    }
  }
  if (!callSign || !INCIDENT_CALLSIGN_PATTERNS.some((pattern) => pattern.test(callSign))) {
    if (!allowCandidate) return null
    const aircraftType = cleanText(aircraft.t || aircraft.aircraftType)
    return {
      icao24,
      callSign: callSign || cleanText(aircraft.r || aircraft.registration) || icao24.toUpperCase(),
      registration: cleanText(aircraft.r || aircraft.registration),
      aircraftType,
      aircraftDescription: cleanText(aircraft.desc || aircraft.aircraftDescription),
      displayType: aircraftDisplayType(aircraft),
      selectionBasis: 'incident-area-candidate',
      candidateEvidence: candidateEvidence(aircraft),
    }
  }
  const aircraftType = cleanText(aircraft.t || aircraft.aircraftType)
  return {
    icao24,
    callSign,
    registration: cleanText(aircraft.r || aircraft.registration),
    aircraftType,
    aircraftDescription: cleanText(aircraft.desc || aircraft.aircraftDescription),
    displayType: aircraftType === 'H47' || /^GRZLY/i.test(callSign) ? 'helicopter' : null,
    selectionBasis: 'incident-callsign',
  }
}

export function normalizeAircraft(
  payload,
  provider,
  requestedAtMs,
  identities = INCIDENT_AIRCRAFT,
  { includeCandidates = false } = {},
) {
  // These providers publish the epoch represented by `seen_pos`. Using it keeps
  // an observation's timestamp stable when two consecutive imports receive the
  // same fix; falling back to our request time preserves compatibility with
  // provider responses that omit `now`.
  const payloadTimestampMs = finiteNumber(payload?.now)
  const referenceTimestampMs = payloadTimestampMs == null
    ? requestedAtMs
    : (payloadTimestampMs > 10_000_000_000 ? payloadTimestampMs : payloadTimestampMs * 1_000)

  return (payload?.ac || payload?.aircraft || []).flatMap((aircraft) => {
    const identity = resolveIncidentAircraft(aircraft, identities, { allowCandidate: includeCandidates })
    if (!identity) return []
    const { icao24 } = identity

    const latitude = finiteNumber(aircraft.lat)
    const longitude = finiteNumber(aircraft.lon)
    if (latitude == null || longitude == null) return []
    const distanceDrossartKm = haversineKm(latitude, longitude)
    // This also rejects the known false MLAT cluster near Aachen/Walheim.
    if (distanceDrossartKm > INCIDENT_RADIUS_KM) return []
    if (identity.selectionBasis === 'incident-area-candidate'
      && !plausibleIncidentCandidate(aircraft, distanceDrossartKm)) return []

    const seenPositionSeconds = Math.max(0, finiteNumber(aircraft.seen_pos) ?? finiteNumber(aircraft.seen) ?? 0)
    const altitudeValue = aircraft.alt_baro === 'ground'
      ? 0
      : finiteNumber(aircraft.alt_baro) ?? finiteNumber(aircraft.alt_geom)

    return [{
      icao24,
      callSign: identity.callSign,
      registration: identity.registration,
      aircraftType: identity.aircraftType,
      aircraftDescription: identity.aircraftDescription,
      displayType: identity.displayType,
      selectionBasis: identity.selectionBasis,
      candidateEvidence: identity.candidateEvidence || [],
      observedAt: new Date(referenceTimestampMs - seenPositionSeconds * 1_000).toISOString(),
      latitude,
      longitude,
      altitudeFt: altitudeValue,
      groundSpeedKt: finiteNumber(aircraft.gs),
      trackDegrees: finiteNumber(aircraft.track),
      seenPositionSeconds,
      distanceDrossartKm,
      routeScope: 'incident-area',
      updateType: `${provider.name} live receiver observation`,
      providerId: provider.id,
      providerName: provider.name,
      providerUrl: provider.website,
    }]
  })
}

function candidateSupportBasis(observations) {
  const evidence = new Set(observations.flatMap((observation) => observation.candidateEvidence || []))
  if (evidence.size) return 'incident-response-type'
  // Multiple receivers can corroborate a position, not an operational role.
  // OOVST and QTR8098 demonstrated that proximity/repetition alone promotes
  // ordinary traffic. Unknown identities now require response-aircraft type,
  // description, rotorcraft category or military metadata; verified hexes and
  // explicit GRZLY callsigns are resolved before this candidate path.
  return null
}

export function promoteIncidentAircraftCandidates(observations = []) {
  const byAircraft = new Map()
  for (const observation of observations) {
    const rows = byAircraft.get(observation.icao24) || []
    rows.push(observation)
    byAircraft.set(observation.icao24, rows)
  }

  return [...byAircraft.values()].flatMap((rows) => {
    const identified = rows.find((row) => row.selectionBasis !== 'incident-area-candidate')
    if (identified) {
      return rows.map((row) => row.selectionBasis !== 'incident-area-candidate' ? row : ({
        ...row,
        callSign: identified.callSign || row.callSign,
        registration: identified.registration || row.registration,
        aircraftType: identified.aircraftType || row.aircraftType,
        aircraftDescription: identified.aircraftDescription || row.aircraftDescription,
        displayType: identified.displayType || row.displayType,
        selectionBasis: identified.selectionBasis,
      }))
    }

    const sessions = []
    rows.slice()
      .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
      .forEach((row) => {
        const current = sessions.at(-1)
        const currentLastMs = Date.parse(current?.at(-1)?.observedAt)
        const rowMs = Date.parse(row.observedAt)
        if (!current || !Number.isFinite(rowMs) || !Number.isFinite(currentLastMs)
          || rowMs - currentLastMs > INCIDENT_CANDIDATE_SESSION_GAP_MS) {
          sessions.push([row])
        } else {
          current.push(row)
        }
      })

    return sessions.flatMap((session) => {
      const selectionBasis = candidateSupportBasis(session)
      if (!selectionBasis) return []
      const evidence = [...new Set(session.flatMap((item) => item.candidateEvidence || []))]
      return session.map((row) => ({ ...row, selectionBasis, candidateEvidence: evidence }))
    })
  })
}

export async function loadAircraft(
  requestedAtMs,
  providers = LIVE_AIRCRAFT_PROVIDERS,
  { includeRaw = false, trackedAircraft = [] } = {},
) {
  const identities = trackedAircraftIdentityMap(trackedAircraft)
  const results = await Promise.all(providers.map((provider) => (
    providerDue(provider, requestedAtMs)
      ? fetchAircraftProvider(provider)
      : Promise.resolve({ provider, polled: false, ok: null })
  )))
  const sourceStatus = []
  const candidatesByHex = new Map()

  results.forEach((result) => {
    const { provider } = result
    if (!result.polled) {
      sourceStatus.push({
        id: provider.id,
        name: provider.name,
        ok: null,
        polled: false,
        intervalMinutes: provider.intervalMinutes || 5,
      })
      return
    }
    if (!result.ok) {
      sourceStatus.push({
        id: provider.id,
        name: provider.name,
        ok: false,
        polled: true,
        intervalMinutes: provider.intervalMinutes || 5,
        statusCode: result.statusCode,
        error: result.error,
      })
      return
    }
    const rows = result.payload?.ac || result.payload?.aircraft || []
    const targetRows = rows.filter((aircraft) => resolveIncidentAircraft(aircraft, identities))
    const normalized = normalizeAircraft(
      result.payload,
      provider,
      requestedAtMs,
      identities,
      { includeCandidates: true },
    )
    sourceStatus.push({
      id: provider.id,
      name: provider.name,
      ok: true,
      polled: true,
      intervalMinutes: provider.intervalMinutes || 5,
      statusCode: result.statusCode,
      aircraftCount: rows.length,
      targetCount: targetRows.length,
      candidateCount: normalized.filter((aircraft) => aircraft.selectionBasis === 'incident-area-candidate').length,
      targetWithPositionCount: targetRows.filter((aircraft) => (
        finiteNumber(aircraft.lat) != null && finiteNumber(aircraft.lon) != null
      )).length,
      acceptedObservationCount: 0,
      candidateIcao24s: normalized.map((aircraft) => aircraft.icao24),
    })
    normalized.forEach((aircraft) => {
      const candidates = candidatesByHex.get(aircraft.icao24) || []
      candidates.push(aircraft)
      candidatesByHex.set(aircraft.icao24, candidates)
    })
  })

  if (!sourceStatus.some((source) => source.ok === true)) {
    throw new Error('All live ADS-B providers failed')
  }

  const promotedCandidates = promoteIncidentAircraftCandidates([...candidatesByHex.values()].flat())
  const promotedByHex = new Map()
  promotedCandidates.forEach((candidate) => {
    const rows = promotedByHex.get(candidate.icao24) || []
    rows.push(candidate)
    promotedByHex.set(candidate.icao24, rows)
  })

  const observations = []
  const conflicts = []
  promotedByHex.forEach((candidates, icao24) => {
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

  const acceptedHexes = new Set(observations.map((observation) => observation.icao24))
  const publicSources = sourceStatus.map(({ candidateIcao24s = [], ...source }) => ({
    ...source,
    acceptedObservationCount: new Set(candidateIcao24s.filter((icao24) => acceptedHexes.has(icao24))).size,
  }))

  return {
    observations,
    conflicts,
    sources: publicSources,
    ...(includeRaw
      ? {
          rawResponses: results.filter((result) => result.polled).map((result) => ({
            provider: result.provider,
            ok: result.ok,
            statusCode: result.statusCode,
            contentType: result.contentType,
            rawBody: result.rawBody,
            error: result.error || null,
          })),
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
    const [datasets, database] = await Promise.all([
      loadPublicDatasets(['weather-open-meteo', 'aircraft', 'reports']),
      databaseOverview(),
    ])
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
