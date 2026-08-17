import { gunzipSync } from 'node:zlib'

import {
  INCIDENT_AIRCRAFT,
  INCIDENT_RADIUS_KM,
  LIVE_AIRCRAFT_PROVIDERS,
  incidentDistanceKm,
  normalizeAircraft,
  promoteIncidentAircraftCandidates,
  trackedAircraftIdentityMap,
} from '../api/live-situation.js'
import { loadDataset, saveDataset } from './database.mjs'
import { FLIGHT_HISTORY_START, persistFlightObservations } from './flight-history.mjs'
import { isExcludedIncidentAircraft } from './aircraft-policy.mjs'
import { archiveProviderResponses } from './source-artifacts.mjs'

export const LEGACY_FLIGHT_MIGRATION_KEY = 'migration-aircraft-history-a80aa9a'
export const LEGACY_FLIGHT_SNAPSHOT_URL = 'https://raw.githubusercontent.com/filoozom/venn-fire/a80aa9a0aa60f6b98d5c559805a1b626bc7ae004/src/incidentAircraftSnapshot.json'
export const AIRCRAFT_ARTIFACT_RECOVERY_KEY = 'aircraft-artifact-recovery'
export const AIRCRAFT_ARTIFACT_OVERLAP_MS = 2 * 60 * 60 * 1_000
export const AIRCRAFT_ARTIFACT_BACKFILL_WINDOW_MS = 6 * 60 * 60 * 1_000
export const AIRCRAFT_ARTIFACT_BACKFILL_OVERLAP_MS = 15 * 60 * 1_000
export const AIRCRAFT_ROUTE_SESSION_GAP_MS = 60 * 60 * 1_000

export const CURRENT_AIRCRAFT_TRACE_PROVIDERS = [
  {
    id: 'adsb-lol-current-trace',
    name: 'ADSB.lol current trace',
    website: 'https://www.adsb.lol/',
    urlFor: (icao24) => `https://globe.adsb.lol/data/traces/${icao24.slice(-2)}/trace_full_${icao24}.json`,
  },
]

export const HISTORICAL_AIRCRAFT_TRACE_PROVIDERS = [
  {
    id: 'airplanes-live-history',
    name: 'Airplanes.live daily history',
    website: 'https://globe.airplanes.live/',
    urlFor: (icao24, date) => `https://globe.airplanes.live/globe_history/${date.replaceAll('-', '/')}/traces/${icao24.slice(-2)}/trace_full_${icao24}.json`,
  },
  {
    id: 'adsb-lol-history',
    name: 'ADSB.lol daily history',
    website: 'https://www.adsb.lol/',
    urlFor: (icao24, date) => `https://adsb.lol/globe_history/${date.replaceAll('-', '/')}/traces/${icao24.slice(-2)}/trace_full_${icao24}.json`,
  },
]

function finiteNumber(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function liveProviderForArtifact(artifact) {
  return LIVE_AIRCRAFT_PROVIDERS.find((provider) => (
    artifact.artifactKey?.endsWith(`:${provider.id}`)
    || artifact.originalPath === provider.endpoint
  )) ?? null
}

function artifactText(artifact) {
  const bytes = Buffer.from(artifact.contentBase64 || '', 'base64')
  if (artifact.contentEncoding === 'gzip') return gunzipSync(bytes).toString('utf8')
  if (artifact.contentEncoding === 'identity') return bytes.toString('utf8')
  throw new Error(`Unsupported aircraft artifact encoding: ${artifact.contentEncoding}`)
}

export function recoverAircraftArtifactObservations(artifacts = [], trackedAircraft = []) {
  const identities = trackedAircraftIdentityMap(trackedAircraft)
  const provisional = []
  const failedArtifacts = []

  for (const artifact of artifacts) {
    const provider = liveProviderForArtifact(artifact)
    if (!provider || !Number.isFinite(Date.parse(artifact.capturedAt))) {
      failedArtifacts.push({ artifactKey: artifact.artifactKey, error: 'Unknown provider or capture time' })
      continue
    }
    try {
      const payload = JSON.parse(artifactText(artifact))
      provisional.push(...normalizeAircraft(
        payload,
        provider,
        Date.parse(artifact.capturedAt),
        identities,
        { includeCandidates: true },
      ))
    } catch (error) {
      failedArtifacts.push({
        artifactKey: artifact.artifactKey,
        error: String(error?.message || error).slice(0, 300),
      })
    }
  }

  const observations = promoteIncidentAircraftCandidates(provisional)
    .filter((observation) => observation.observedAt >= FLIGHT_HISTORY_START)
  const provisionalCandidates = provisional.filter((observation) => (
    observation.selectionBasis === 'incident-area-candidate'
  ))
  const promotedIcao24s = new Set(observations
    .filter((observation) => observation.selectionBasis.startsWith('incident-'))
    .map((observation) => observation.icao24))
  const provisionalIcao24s = new Set(provisionalCandidates.map((observation) => observation.icao24))

  return {
    observations,
    provisionalObservationCount: provisional.length,
    provisionalCandidateCount: provisionalCandidates.length,
    provisionalCandidateAircraftCount: provisionalIcao24s.size,
    promotedCandidateAircraftCount: [...promotedIcao24s]
      .filter((icao24) => provisionalIcao24s.has(icao24)).length,
    rejectedCandidateAircraftCount: [...provisionalIcao24s]
      .filter((icao24) => !promotedIcao24s.has(icao24)).length,
    failedArtifacts,
  }
}

export function trackedAircraftFromObservations(observations = [], {
  includeConfigured = true,
  observedAfter = null,
} = {}) {
  const observedAfterMs = observedAfter == null ? null : Date.parse(observedAfter)
  const tracked = new Map(
    (includeConfigured ? [...INCIDENT_AIRCRAFT] : [])
      .filter(([icao24]) => !isExcludedIncidentAircraft(icao24))
      .map(([icao24, identity]) => [icao24, {
      icao24,
      ...identity,
      selectionBasis: 'verified-icao24',
      }]),
  )
  for (const observation of observations || []) {
    if (Number.isFinite(observedAfterMs)
      && Date.parse(observation?.observedAt) < observedAfterMs) continue
    const icao24 = String(observation?.icao24 || '').trim().toLowerCase()
    if (!/^[0-9a-f]{6}$/.test(icao24)) continue
    if (isExcludedIncidentAircraft(icao24)) continue
    const existing = tracked.get(icao24) || { icao24 }
    tracked.set(icao24, {
      ...existing,
      callSign: observation.callSign || existing.callSign || icao24.toUpperCase(),
      registration: observation.registration || existing.registration || null,
      aircraftType: observation.aircraftType || existing.aircraftType || null,
      aircraftDescription: observation.aircraftDescription || existing.aircraftDescription || null,
      displayType: observation.displayType || existing.displayType || null,
      selectionBasis: INCIDENT_AIRCRAFT.has(icao24)
        ? 'verified-icao24'
        : observation.selectionBasis || existing.selectionBasis || 'retained-incident-history',
    })
  }
  return [...tracked.values()]
}

export function normalizeAircraftTrace(payload, aircraft, provider) {
  const icao24 = String(aircraft?.icao24 || '').toLowerCase()
  if (isExcludedIncidentAircraft(icao24)) return []
  const configuredIdentity = INCIDENT_AIRCRAFT.get(icao24)
  const identity = configuredIdentity || (aircraft?.selectionBasis ? aircraft : null)
  const baseTimestamp = finiteNumber(payload?.timestamp)
  if (!identity || baseTimestamp == null) return []
  const baseTimestampMs = baseTimestamp * 1_000

  const seen = new Set()
  const observations = (Array.isArray(payload.trace) ? payload.trace : []).flatMap((row) => {
    if (!Array.isArray(row)) return []
    const offsetSeconds = finiteNumber(row[0])
    const latitude = finiteNumber(row[1])
    const longitude = finiteNumber(row[2])
    if (offsetSeconds == null || latitude == null || longitude == null) return []
    const observedAt = new Date(baseTimestampMs + offsetSeconds * 1_000).toISOString()
    if (observedAt < FLIGHT_HISTORY_START) return []
    const distanceDrossartKm = incidentDistanceKm(latitude, longitude)
    const key = `${observedAt}|${latitude}|${longitude}`
    if (seen.has(key)) return []
    seen.add(key)

    const metadata = row[8] && typeof row[8] === 'object' ? row[8] : {}
    const altitudeFt = row[3] === 'ground' ? 0 : finiteNumber(row[3])
    const traceType = String(row[9] || metadata.type || 'receiver').trim().toLowerCase()
    return [{
      icao24,
      callSign: String(metadata.flight || aircraft.callSign || identity.callSign).trim() || identity.callSign,
      registration: payload.r || aircraft.registration || identity.registration,
      aircraftType: payload.t || aircraft.aircraftType || identity.aircraftType || null,
      aircraftDescription: payload.desc
        || aircraft.aircraftDescription
        || identity.aircraftDescription
        || null,
      displayType: aircraft.displayType || identity.displayType || null,
      selectionBasis: aircraft.selectionBasis || identity.selectionBasis || 'verified-icao24',
      observedAt,
      latitude,
      longitude,
      altitudeFt,
      groundSpeedKt: finiteNumber(row[4]),
      trackDegrees: finiteNumber(row[5]),
      distanceDrossartKm,
      routeScope: distanceDrossartKm <= INCIDENT_RADIUS_KM ? 'incident-area' : 'full-route',
      updateType: `${provider.name} ${traceType} observation`,
      providerId: provider.id,
      providerName: provider.name,
      providerUrl: provider.website,
      corroboratedBy: [],
    }]
  })

  // Daily trace files can contain multiple unrelated flights by one airframe.
  // Keep every complete available session that actually enters the incident
  // area, including its approach and departure, but not a separate session
  // elsewhere that day. A one-hour receiver gap is a conservative boundary;
  // shorter coverage gaps remain connected and are still broken visually by
  // the map's stricter two-minute connector rule.
  const sessions = []
  observations
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
    .forEach((observation) => {
      const session = sessions.at(-1)
      const previous = session?.at(-1)
      if (!previous
        || Date.parse(observation.observedAt) - Date.parse(previous.observedAt) > AIRCRAFT_ROUTE_SESSION_GAP_MS) {
        sessions.push([observation])
      } else {
        session.push(observation)
      }
    })
  return sessions.flatMap((session) => (
    session.some((observation) => observation.routeScope === 'incident-area') ? session : []
  ))
}

async function fetchTrace(provider, aircraft, date) {
  const originalPath = provider.urlFor(aircraft.icao24, date)
  try {
    const response = await fetch(originalPath, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Venn-Fire-Watch/1.0 (+https://venn-fire.vercel.app/)',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    })
    const rawBody = await response.text()
    const base = {
      provider,
      icao24: aircraft.icao24,
      originalPath,
      statusCode: response.status,
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      rawBody,
    }
    if (!response.ok) return { ...base, ok: false, error: `HTTP ${response.status}` }
    try {
      const payload = JSON.parse(rawBody)
      return {
        ...base,
        ok: true,
        payload,
        observations: normalizeAircraftTrace(payload, aircraft, provider),
      }
    } catch {
      return { ...base, ok: false, error: 'Invalid JSON response' }
    }
  } catch (error) {
    return {
      provider,
      icao24: aircraft.icao24,
      originalPath,
      statusCode: null,
      contentType: 'application/json',
      rawBody: null,
      ok: false,
      error: String(error?.message || error),
    }
  }
}

export async function loadAircraftTraces({
  providers,
  date = null,
  aircraft = trackedAircraftFromObservations(),
}) {
  const responses = await Promise.all(providers.flatMap((provider) => (
    aircraft.map((item) => fetchTrace(provider, item, date))
  )))
  return {
    responses,
    observations: responses.flatMap((response) => response.observations || []),
    sources: responses.map((response) => ({
      id: response.provider.id,
      name: response.provider.name,
      icao24: response.icao24,
      ok: response.ok,
      statusCode: response.statusCode,
      observationCount: response.observations?.length || 0,
      error: response.error || null,
    })),
  }
}

export function normalizeLegacyFlightSnapshot(snapshot) {
  const sources = new Map((snapshot.sources || []).map((source) => [source.id, source]))
  return (snapshot.aircraft || []).flatMap((aircraft) => (
    (aircraft.observations || []).flatMap((row) => {
      const [observedAt, latitudeValue, longitudeValue, altitudeValue, sourceId] = row
      const latitude = finiteNumber(latitudeValue)
      const longitude = finiteNumber(longitudeValue)
      const source = sources.get(sourceId)
      if (!source || latitude == null || longitude == null || !Number.isFinite(Date.parse(observedAt))) return []
      const distanceDrossartKm = incidentDistanceKm(latitude, longitude)
      if (distanceDrossartKm > INCIDENT_RADIUS_KM) return []
      return [{
        icao24: String(aircraft.icao24).toLowerCase(),
        callSign: aircraft.callSign,
        registration: aircraft.registration,
        observedAt: new Date(observedAt).toISOString(),
        latitude,
        longitude,
        altitudeFt: finiteNumber(altitudeValue),
        groundSpeedKt: null,
        trackDegrees: null,
        distanceDrossartKm,
        routeScope: 'incident-area',
        updateType: `${source.name} ${source.product} observation`,
        providerId: source.id,
        providerName: source.name,
        providerUrl: source.url,
        corroboratedBy: [],
      }]
    })
  ))
}

export async function backfillLegacyFlightHistory({
  requestedAtMs,
  query,
}) {
  const existing = await loadDataset(LEGACY_FLIGHT_MIGRATION_KEY, query)
  if (existing) return { ...existing.payload, applied: false }

  const response = await fetch(LEGACY_FLIGHT_SNAPSHOT_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Venn-Fire-Watch/1.0 (+https://venn-fire.vercel.app/)',
    },
    signal: AbortSignal.timeout(15_000),
  })
  const rawBody = await response.text()
  if (!response.ok) throw new Error(`Legacy flight snapshot returned HTTP ${response.status}`)
  const snapshot = JSON.parse(rawBody)
  const observations = normalizeLegacyFlightSnapshot(snapshot)
  if (observations.length !== 51) {
    throw new Error(`Legacy flight snapshot validation returned ${observations.length} observations instead of 51`)
  }

  const capturedAt = new Date(requestedAtMs).toISOString()
  const artifacts = await archiveProviderResponses({
    sourceKey: 'aircraft-legacy-backfill',
    bucketAt: capturedAt,
    responses: [{
      providerId: 'git-history-snapshot',
      originalPath: LEGACY_FLIGHT_SNAPSHOT_URL,
      statusCode: response.status,
      contentType: response.headers.get('content-type') || 'application/json',
      rawBody,
    }],
  }, query)
  const persisted = await persistFlightObservations({ observations }, { databaseUrl: '', query })
  const payload = {
    schemaVersion: 1,
    generatedAt: capturedAt,
    sourceUrl: LEGACY_FLIGHT_SNAPSHOT_URL,
    snapshotGeneratedAt: snapshot.generatedAt,
    observationCount: observations.length,
    persistedObservationCount: persisted.persistedObservations,
    artifact: artifacts[0],
  }
  await saveDataset({
    key: LEGACY_FLIGHT_MIGRATION_KEY,
    payload,
    sourceUpdatedAt: snapshot.generatedAt,
  }, query)
  return { ...payload, applied: true }
}
