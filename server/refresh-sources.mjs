import { createHash } from 'node:crypto'

import { strFromU8, unzipSync } from 'fflate'

import { loadFirms } from '../api/firms-situation.js'
import { loadAreaReports } from '../api/live-reports.js'
import { loadAircraft, loadWeather } from '../api/live-situation.js'
import { FIRMS_SENSORS } from '../src/firmsDetections.js'
import {
  AIRCRAFT_ARTIFACT_BACKFILL_OVERLAP_MS,
  AIRCRAFT_ARTIFACT_BACKFILL_WINDOW_MS,
  AIRCRAFT_ARTIFACT_OVERLAP_MS,
  AIRCRAFT_ARTIFACT_RECOVERY_KEY,
  backfillLegacyFlightHistory,
  CURRENT_AIRCRAFT_TRACE_PROVIDERS,
  HISTORICAL_AIRCRAFT_TRACE_PROVIDERS,
  loadAircraftTraces,
  recoverAircraftArtifactObservations,
  trackedAircraftFromObservations,
} from './aircraft-sources.mjs'
import {
  claimSourceRefresh,
  completeSourceRefresh,
  databaseQuery,
  failSourceRefresh,
  listArtifacts,
  loadDataset,
  loadDatasetVersionPayloads,
  saveArtifact,
  saveDataset,
} from './database.mjs'
import { backfillLegacyEffisHistory } from './effis-sources.mjs'
import {
  refreshCams,
  refreshDwdRadarHistory,
  refreshNasaGibs,
  refreshRmiRadar,
  refreshSentinel1,
  refreshSentinel3Frp,
} from './environmental-sources.mjs'
import {
  flightObservationKey,
  persistFlightObservations,
  persistFlightPoll,
} from './flight-history.mjs'
import { refreshVedia } from './media-sources.mjs'
import { refreshMunicipalUpdates } from './municipal-sources.mjs'
import { backfillLegacyReportHistory } from './report-sources.mjs'
import {
  deriveSentinelBurnAnalysis,
  searchSentinelAnalysisScenes,
  SENTINEL_EARTH_SEARCH_URL,
} from './sentinel-analysis.mjs'
import { archiveProviderResponses } from './source-artifacts.mjs'

const INCIDENT = { latitude: 50.54762, longitude: 6.05757 }
const INCIDENT_START = '2026-08-14T11:00:00.000Z'
const AIRCRAFT_ROUTE_HISTORY_RECOVERY_KEY = 'aircraft-route-history-recovery'
export const INCIDENT_WATER_CONTEXT_ENTITIES = Object.freeze([
  'Q165395', // Lake Eupen / Wesertalsperre
  'Q17373262', // Gileppe reservoir
  'Q320702', // Lake Robertville / Talsperre Robertville
  'Q470432', // Lake Bütgenbach / Stausee Bütgenbach
])

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function haversineKm(latitude, longitude) {
  const radians = Math.PI / 180
  const deltaLatitude = (latitude - INCIDENT.latitude) * radians
  const deltaLongitude = (longitude - INCIDENT.longitude) * radians
  const value = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(INCIDENT.latitude * radians) * Math.cos(latitude * radians) * Math.sin(deltaLongitude / 2) ** 2
  return 6371.0088 * 2 * Math.asin(Math.sqrt(value))
}

async function fetchText(url, { timeoutMs = 20_000, headers = {} } = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  const body = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`)
  return body
}

async function fetchJson(url, options) {
  return JSON.parse(await fetchText(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options?.headers || {}) },
  }))
}

async function fetchBytes(url, timeoutMs = 30_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`)
  return new Uint8Array(await response.arrayBuffer())
}

function mergeRows(previous, incoming, key, compare) {
  const rows = new Map()
  for (const row of [...(previous || []), ...(incoming || [])]) {
    const rowKey = key(row)
    if (rowKey) rows.set(rowKey, row)
  }
  return [...rows.values()].sort(compare)
}

async function previousPayload(key, query, fallback = {}) {
  return (await loadDataset(key, query))?.payload ?? fallback
}

export function mapLabelFromWikidata(entityId, response) {
  const entity = response?.entities?.[entityId]
  const coordinate = entity?.claims?.P625?.[0]?.mainsnak?.datavalue?.value
  const latitude = finiteNumber(coordinate?.latitude)
  const longitude = finiteNumber(coordinate?.longitude)
  const names = {
    de: entity?.labels?.de?.value || entity?.labels?.en?.value,
    en: entity?.labels?.en?.value || entity?.labels?.de?.value,
  }
  if (!entity || latitude == null || longitude == null || !names.de || !names.en) {
    throw new Error(`Wikidata entity ${entityId} has no usable coordinate or German/English label`)
  }
  return {
    id: `wikidata-${entityId.toLowerCase()}`,
    kind: 'water',
    name: names.en,
    names,
    position: [latitude, longitude],
    context: 'nearby-reservoir',
    sourceUrl: `https://www.wikidata.org/wiki/${entityId}`,
  }
}

async function refreshIncidentMapContext({ requestedAtMs, query }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const previous = await previousPayload('incident-config', query)
  if (!Array.isArray(previous.incidentCenter)) {
    throw new Error('Incident configuration is unavailable')
  }
  const mapLabels = await Promise.all(INCIDENT_WATER_CONTEXT_ENTITIES.map(async (entityId) => (
    mapLabelFromWikidata(entityId, await fetchJson(
      `https://www.wikidata.org/wiki/Special:EntityData/${entityId}.json`,
      { headers: { 'User-Agent': 'VennFireWatch/1.0 (https://venn-fire.vercel.app/)' } },
    ))
  )))
  const managedIds = new Set(mapLabels.map((label) => label.id))
  const retainedLabels = (previous.mapLabels ?? []).filter((label) => !managedIds.has(label.id))
  const stored = await saveDataset({
    key: 'incident-config',
    payload: {
      ...previous,
      mapLabels: [...retainedLabels, ...mapLabels],
    },
    sourceUpdatedAt: generatedAt,
  }, query)
  return {
    itemCount: mapLabels.length,
    metadata: {
      changed: stored.changed,
      entityIds: INCIDENT_WATER_CONTEXT_ENTITIES,
      context: 'Nearby reservoirs are map context only; no aircraft water pickup is asserted.',
    },
  }
}

async function refreshAircraft({ requestedAtMs, query, bucketAt }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const backfill = await backfillLegacyFlightHistory({ requestedAtMs, query })
  const previous = await previousPayload('aircraft', query, { observations: [] })
  const trackedAircraft = trackedAircraftFromObservations(previous.observations)
  const result = await loadAircraft(requestedAtMs, undefined, { includeRaw: true, trackedAircraft })
  const artifacts = await archiveProviderResponses({
    sourceKey: 'aircraft-live',
    bucketAt,
    responses: result.rawResponses,
  }, query)
  const history = await persistFlightPoll({ generatedAt, ...result })
  const payload = {
    schemaVersion: 1,
    generatedAt,
    observations: history.observations,
    latestObservations: result.observations,
    conflicts: result.conflicts,
    sources: result.sources,
    retentionPolicy: 'incident lifetime',
  }
  const stored = await saveDataset({ key: 'aircraft', payload }, query)
  return {
    itemCount: history.observations.length,
    metadata: {
      changed: stored.changed,
      healthyProviders: result.sources.filter((source) => source.ok === true).map((source) => source.id),
      failedProviders: result.sources.filter((source) => source.ok === false).map((source) => source.id),
      deferredProviders: result.sources.filter((source) => source.polled === false).map((source) => source.id),
      rawArtifactCount: artifacts.length,
      rawArtifacts: artifacts.map((artifact) => artifact.artifactKey),
      legacyBackfillApplied: backfill.applied,
      legacyBackfillObservationCount: backfill.observationCount,
    },
  }
}

async function refreshAircraftArtifacts({ requestedAtMs, query }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const [previousAircraft, previousRecovery] = await Promise.all([
    previousPayload('aircraft', query, { observations: [] }),
    previousPayload(AIRCRAFT_ARTIFACT_RECOVERY_KEY, query, {}),
  ])
  const fullBackfill = !previousRecovery.fullBackfillCompletedAt
  const recentAfterMs = requestedAtMs - AIRCRAFT_ARTIFACT_OVERLAP_MS
  const recentAfter = new Date(recentAfterMs).toISOString()
  const artifactLimit = 1_000
  const windows = [{ capturedAfter: recentAfter, capturedBefore: generatedAt, kind: 'recent' }]
  let nextBackfillCursorBefore = previousRecovery.fullBackfillCursorBefore || recentAfter
  let fullBackfillCompletedAt = previousRecovery.fullBackfillCompletedAt || null

  if (fullBackfill) {
    const incidentStartMs = Date.parse(INCIDENT_START)
    const backfillBeforeMs = Math.min(
      Date.parse(nextBackfillCursorBefore) || recentAfterMs,
      recentAfterMs,
    )
    const backfillAfterMs = Math.max(
      incidentStartMs,
      backfillBeforeMs - AIRCRAFT_ARTIFACT_BACKFILL_WINDOW_MS,
    )
    windows.push({
      capturedAfter: new Date(backfillAfterMs).toISOString(),
      capturedBefore: new Date(backfillBeforeMs).toISOString(),
      kind: 'backfill',
    })
    if (backfillAfterMs <= incidentStartMs) {
      nextBackfillCursorBefore = INCIDENT_START
      fullBackfillCompletedAt = generatedAt
    } else {
      nextBackfillCursorBefore = new Date(
        backfillAfterMs + AIRCRAFT_ARTIFACT_BACKFILL_OVERLAP_MS,
      ).toISOString()
    }
  }

  const artifactWindows = await Promise.all(windows.map(async (window) => {
    const rows = await listArtifacts({
      sourceKey: 'aircraft-live',
      capturedAfter: window.capturedAfter,
      capturedBefore: window.capturedBefore,
      limit: artifactLimit,
    }, query)
    if (rows.length >= artifactLimit) {
      throw new Error(`Aircraft ${window.kind} recovery window exceeded the ${artifactLimit} artifact safety limit`)
    }
    return { ...window, rows }
  }))
  const artifacts = [...new Map(artifactWindows
    .flatMap((window) => window.rows)
    .map((artifact) => [artifact.artifactKey, artifact])).values()]

  const trackedAircraft = trackedAircraftFromObservations(previousAircraft.observations)
  const recovered = recoverAircraftArtifactObservations(artifacts, trackedAircraft)
  const recoverySignature = (observation) => JSON.stringify([
    observation.callSign || null,
    observation.registration || null,
    observation.aircraftType || null,
    observation.displayType || null,
    observation.selectionBasis || null,
    [...(observation.candidateEvidence || [])].sort(),
  ])
  const existingByKey = new Map((previousAircraft.observations || []).map((observation) => [
    flightObservationKey(observation),
    recoverySignature(observation),
  ]))
  const recoveredUpdates = recovered.observations.filter((observation) => (
    existingByKey.get(flightObservationKey(observation)) !== recoverySignature(observation)
  ))
  let persistedObservationCount = 0
  let storedAircraft = { changed: false }
  if (recoveredUpdates.length) {
    const persisted = await persistFlightObservations(
      { observations: recoveredUpdates },
      { databaseUrl: '', query },
    )
    persistedObservationCount = persisted.persistedObservations
    storedAircraft = await saveDataset({
      key: 'aircraft',
      payload: {
        ...previousAircraft,
        schemaVersion: previousAircraft.schemaVersion || 1,
        generatedAt,
        observations: persisted.observations,
        retentionPolicy: 'incident lifetime',
      },
    }, query)
  }
  const recoveryPayload = {
    schemaVersion: 1,
    generatedAt,
    fullBackfillCompletedAt,
    fullBackfillCursorBefore: nextBackfillCursorBefore,
    artifactCount: artifacts.length,
    provisionalObservationCount: recovered.provisionalObservationCount,
    recoveredObservationCount: recovered.observations.length,
    updateObservationCount: recoveredUpdates.length,
    upsertedObservationCount: persistedObservationCount,
    provisionalCandidateAircraftCount: recovered.provisionalCandidateAircraftCount,
    promotedCandidateAircraftCount: recovered.promotedCandidateAircraftCount,
    rejectedCandidateAircraftCount: recovered.rejectedCandidateAircraftCount,
    failedArtifactCount: recovered.failedArtifacts.length,
  }
  const storedRecovery = await saveDataset({
    key: AIRCRAFT_ARTIFACT_RECOVERY_KEY,
    payload: recoveryPayload,
    sourceUpdatedAt: generatedAt,
  }, query)
  return {
    itemCount: recovered.observations.length,
    metadata: {
      changed: storedAircraft.changed || storedRecovery.changed,
      fullBackfill,
      fullBackfillCompleted: Boolean(fullBackfillCompletedAt),
      fullBackfillCursorBefore: nextBackfillCursorBefore,
      aircraftDatasetChanged: storedAircraft.changed,
      artifactCount: artifacts.length,
      windows: artifactWindows.map((window) => ({
        kind: window.kind,
        capturedAfter: window.capturedAfter,
        capturedBefore: window.capturedBefore,
        artifactCount: window.rows.length,
      })),
      failedArtifactCount: recovered.failedArtifacts.length,
      provisionalObservationCount: recovered.provisionalObservationCount,
      recoveredObservationCount: recovered.observations.length,
      updateObservationCount: recoveredUpdates.length,
      upsertedObservationCount: persistedObservationCount,
      provisionalCandidateAircraftCount: recovered.provisionalCandidateAircraftCount,
      promotedCandidateAircraftCount: recovered.promotedCandidateAircraftCount,
      rejectedCandidateAircraftCount: recovered.rejectedCandidateAircraftCount,
    },
  }
}

async function refreshAircraftTraceSource({
  query,
  bucketAt,
  providers,
  date = null,
  sourceKey,
  includeConfigured = true,
  observedAfter = null,
  aircraftOverride = null,
}) {
  const previous = await previousPayload('aircraft', query, { observations: [] })
  const aircraft = aircraftOverride || trackedAircraftFromObservations(previous.observations, {
      includeConfigured,
      observedAfter,
    })
  const result = await loadAircraftTraces({ providers, date, aircraft })
  const artifacts = await archiveProviderResponses({
    sourceKey,
    bucketAt,
    responses: result.responses,
  }, query)
  const persisted = await persistFlightObservations(
    { observations: result.observations },
    { databaseUrl: '', query },
  )
  const stored = await saveDataset({
    key: 'aircraft',
    payload: {
      ...previous,
      schemaVersion: previous.schemaVersion || 1,
      generatedAt: new Date().toISOString(),
      observations: persisted.observations,
      retentionPolicy: 'incident lifetime',
    },
  }, query)
  const healthy = result.sources.filter((source) => source.ok)
  const failed = result.sources.filter((source) => !source.ok)
  return {
    itemCount: result.observations.length,
    metadata: {
      date,
      complete: failed.length === 0,
      responseCount: result.responses.length,
      trackedAircraftCount: aircraft.length,
      healthyResponseCount: healthy.length,
      failedResponseCount: failed.length,
      failedResponses: failed.map((source) => ({
        providerId: source.id,
        icao24: source.icao24,
        statusCode: source.statusCode,
        error: source.error,
      })),
      receivedObservationCount: result.observations.length,
      upsertedObservationCount: persisted.persistedObservations,
      historyObservationCount: persisted.observations.length,
      aircraftDatasetChanged: stored.changed,
      rawArtifactCount: artifacts.length,
      rawArtifacts: artifacts.map((artifact) => artifact.artifactKey),
    },
  }
}

async function refreshCurrentAircraftTraces({ requestedAtMs, query, bucketAt }) {
  return refreshAircraftTraceSource({
    query,
    bucketAt,
    providers: CURRENT_AIRCRAFT_TRACE_PROVIDERS,
    sourceKey: 'aircraft-traces',
    includeConfigured: false,
    observedAfter: new Date(requestedAtMs - 36 * 60 * 60 * 1_000).toISOString(),
  })
}

async function refreshHistoricalAircraftTraces({ requestedAtMs, query, bucketAt }) {
  const date = new Date(requestedAtMs - 24 * 60 * 60 * 1_000).toISOString().slice(0, 10)
  return refreshAircraftTraceSource({
    query,
    bucketAt,
    providers: HISTORICAL_AIRCRAFT_TRACE_PROVIDERS,
    date,
    sourceKey: 'aircraft-history',
  })
}

export function completedUtcDatesBeforeToday(requestedAtMs) {
  const firstDateMs = Date.parse(`${INCIDENT_START.slice(0, 10)}T00:00:00.000Z`)
  const todayMs = Date.parse(`${new Date(requestedAtMs).toISOString().slice(0, 10)}T00:00:00.000Z`)
  const dates = []
  for (let dateMs = todayMs - 24 * 60 * 60 * 1_000; dateMs >= firstDateMs; dateMs -= 24 * 60 * 60 * 1_000) {
    dates.push(new Date(dateMs).toISOString().slice(0, 10))
  }
  return dates
}

export function routeRecoveryTargets(observations, date) {
  const rows = (observations || []).filter((observation) => {
    if (String(observation?.observedAt || '').slice(0, 10) !== date) return false
    if (observation.routeScope === 'full-route') return false
    const distanceKm = finiteNumber(observation.distanceDrossartKm)
      ?? haversineKm(Number(observation.latitude), Number(observation.longitude))
    return Number.isFinite(distanceKm) && distanceKm <= 10
  })
  return trackedAircraftFromObservations(rows, { includeConfigured: false })
    .sort((left, right) => left.icao24.localeCompare(right.icao24))
}

async function refreshAircraftRouteHistory({ requestedAtMs, query, bucketAt }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const [previousAircraft, previousRecovery] = await Promise.all([
    previousPayload('aircraft', query, { observations: [] }),
    previousPayload(AIRCRAFT_ROUTE_HISTORY_RECOVERY_KEY, query, { dates: {} }),
  ])
  const priorDates = previousRecovery.dates || {}
  const pending = completedUtcDatesBeforeToday(requestedAtMs).flatMap((date) => {
    const aircraft = routeRecoveryTargets(previousAircraft.observations, date)
    const fingerprint = aircraft.map((item) => item.icao24).join(',')
    return aircraft.length && priorDates[date]?.fingerprint !== fingerprint
      ? [{ date, aircraft, fingerprint }]
      : []
  })

  if (!pending.length) {
    return {
      itemCount: 0,
      metadata: {
        changed: false,
        complete: true,
        recoveredDates: Object.keys(priorDates).sort(),
        pendingDateCount: 0,
      },
    }
  }

  // Recover one completed day per five-minute run so the work is resumable and
  // upstream requests remain bounded. The newest missing day is handled first.
  const target = pending[0]
  const result = await refreshAircraftTraceSource({
    query,
    bucketAt,
    providers: HISTORICAL_AIRCRAFT_TRACE_PROVIDERS,
    date: target.date,
    sourceKey: 'aircraft-route-history',
    includeConfigured: false,
    aircraftOverride: target.aircraft,
  })
  const dates = {
    ...priorDates,
    [target.date]: {
      fingerprint: target.fingerprint,
      icao24s: target.aircraft.map((aircraft) => aircraft.icao24),
      attemptedAt: generatedAt,
      complete: result.metadata.complete,
      receivedObservationCount: result.metadata.receivedObservationCount,
      failedResponses: result.metadata.failedResponses,
    },
  }
  const stored = await saveDataset({
    key: AIRCRAFT_ROUTE_HISTORY_RECOVERY_KEY,
    payload: { schemaVersion: 1, generatedAt, dates },
    sourceUpdatedAt: generatedAt,
  }, query)
  return {
    ...result,
    metadata: {
      ...result.metadata,
      changed: result.metadata.changed || stored.changed,
      recoveryDate: target.date,
      recoveredDates: Object.keys(dates).sort(),
      pendingDateCount: Math.max(0, pending.length - 1),
    },
  }
}

async function refreshOpenMeteo({ requestedAtMs, query }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const [incoming, previous] = await Promise.all([
    loadWeather(),
    previousPayload('weather-open-meteo', query, { rows: [] }),
  ])
  const normalized = incoming.rows.map((row) => ({
    ...row,
    sourceKind: 'model',
    cadenceMinutes: 60,
    validationStatus: 'not-applicable',
    stationPosition: [INCIDENT.latitude, INCIDENT.longitude],
  }))
  const rows = mergeRows(
    previous.rows,
    normalized,
    (row) => row.observedAt,
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt),
  )
  const payload = {
    schemaVersion: 1,
    generatedAt,
    rows,
    current: incoming.current,
    hourlyUnits: incoming.hourlyUnits,
    source: { name: 'Open-Meteo', url: 'https://open-meteo.com/' },
  }
  const stored = await saveDataset({ key: 'weather-open-meteo', payload }, query)
  return { itemCount: rows.length, metadata: { changed: stored.changed } }
}

function mergeAreaReports(previous, incoming) {
  const bySourceAndTime = new Map()
  for (const report of [...(previous || []), ...(incoming || [])]) {
    const fallbackTimestampMs = Number.isFinite(report?.timestampMs)
      ? report.timestampMs
      : Date.parse(report?.observedAt)
    const effectiveTimestampMs = Number.isFinite(report?.effectiveTimestampMs)
      ? report.effectiveTimestampMs
      : fallbackTimestampMs
    const publishedAtMs = Number.isFinite(report?.publishedAtMs)
      ? report.publishedAtMs
      : Date.parse(report?.publishedAt) || effectiveTimestampMs
    if (!Number.isFinite(effectiveTimestampMs) || !Number.isFinite(publishedAtMs)
      || !Number.isFinite(Number(report?.reportedHa)) || !report?.source) continue
    bySourceAndTime.set(`${report.source}|${effectiveTimestampMs}|${publishedAtMs}`, {
      ...report,
      timestampMs: effectiveTimestampMs,
      effectiveTimestampMs,
      effectiveAt: report.effectiveAt || new Date(effectiveTimestampMs).toISOString(),
      publishedAtMs,
      publishedAt: report.publishedAt || new Date(publishedAtMs).toISOString(),
    })
  }
  const seenValues = new Set()
  return [...bySourceAndTime.values()]
    .sort((left, right) => (
      left.publishedAtMs - right.publishedAtMs
      || left.effectiveTimestampMs - right.effectiveTimestampMs
    ))
    .filter((report) => {
      const key = `${report.source}|${report.areaPrefix}|${report.reportedHa}`
      if (seenValues.has(key)) return false
      seenValues.add(key)
      return true
    })
}

function mergeReportEvents(previous, incoming) {
  const byId = new Map()
  for (const event of [...(previous || []), ...(incoming || [])]) {
    const timestampMs = Number.isFinite(event?.timestampMs)
      ? event.timestampMs
      : Date.parse(event?.observedAt)
    if (!Number.isFinite(timestampMs) || !event?.id || !event?.title || !event?.sourceUrl) continue
    byId.set(event.id, { ...event, timestampMs })
  }
  return [...byId.values()].sort((left, right) => left.timestampMs - right.timestampMs)
}

async function refreshReports({ requestedAtMs, query }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const [incoming, previous, historicalVersions, legacyHistory] = await Promise.all([
    loadAreaReports(),
    previousPayload('reports', query, { areaReports: [] }),
    loadDatasetVersionPayloads('reports', { limit: 1_000 }, query),
    backfillLegacyReportHistory({ requestedAtMs, query }),
  ])
  if (!incoming.ok) throw new Error('No live situation-report source succeeded')
  const historicalAreaReports = historicalVersions.flatMap((payload) => payload.areaReports || [])
  const historicalEvents = historicalVersions.flatMap((payload) => payload.events || [])
  const areaReports = mergeAreaReports(
    [...(legacyHistory.reports || []), ...historicalAreaReports, ...(previous.areaReports || [])],
    incoming.areaReports,
  )
  const events = mergeReportEvents(
    [...historicalEvents, ...(previous.events || [])],
    incoming.events,
  )
  const payload = { schemaVersion: 1, generatedAt, ...incoming, areaReports, events }
  const stored = await saveDataset({ key: 'reports', payload }, query)
  return {
    itemCount: areaReports.length + events.length,
    metadata: {
      changed: stored.changed,
      complete: incoming.complete,
      areaReportCount: areaReports.length,
      eventCount: events.length,
      historicalVersionCount: historicalVersions.length,
      legacyBackfillApplied: legacyHistory.applied,
      legacyBackfillReportCount: legacyHistory.reportCount,
    },
  }
}

const ALERT_FEED_URL = 'https://publicalerts.be/CapGateway/feed'
const ALERT_URL = 'https://publicalerts.be/CapGateway/alert/'
const ALERT_PORTAL_URL = 'https://publicalerts.be/CapGateway/#!/?lang=en'

function normalizeAlertGeometries(areas) {
  return (areas ?? []).flatMap((area) => (area.coordinates ?? []).flatMap((geometry) => {
    const points = (geometry.coordinates ?? [])
      .map((point) => (Array.isArray(point) ? point : [point.x, point.y]))
      .filter(([longitude, latitude]) => Number.isFinite(longitude) && Number.isFinite(latitude))
    return points.length < 2
      ? []
      : [{ type: geometry.type, ring: points.map(([longitude, latitude]) => [latitude, longitude]) }]
  }))
}

function capField(xml, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)
  return match?.[1]?.trim()
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>') || null
}

async function refreshAlerts({ requestedAtMs, query }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const [feed, previous] = await Promise.all([
    fetchJson(ALERT_FEED_URL, { timeoutMs: 25_000 }),
    previousPayload('public-alerts', query, { alerts: [] }),
  ])
  const seen = await Promise.all((feed.items ?? []).map(async (item) => {
    const geometries = normalizeAlertGeometries(item.area)
    const distances = geometries.flatMap((geometry) => (
      geometry.ring.map(([latitude, longitude]) => haversineKm(latitude, longitude))
    ))
    const nearestKmFromDrossart = distances.length ? Math.min(...distances) : null
    let cap = {}
    try {
      const xml = await fetchText(`${ALERT_URL}${item.guid}`, { timeoutMs: 15_000 })
      cap = {
        identifier: capField(xml, 'identifier'),
        sender: capField(xml, 'sender'),
        sentAt: capField(xml, 'sent'),
        status: capField(xml, 'status'),
        msgType: capField(xml, 'msgType'),
        urgency: capField(xml, 'urgency'),
        severity: capField(xml, 'severity'),
        certainty: capField(xml, 'certainty'),
        headline: capField(xml, 'headline'),
        capDescription: capField(xml, 'description'),
        areaDesc: capField(xml, 'areaDesc'),
      }
    } catch (error) {
      cap = { capError: String(error?.message || error) }
    }
    return {
      guid: item.guid,
      title: String(item.title || '').replace(/\s+/g, ' ').trim(),
      description: String(item.description || '').replace(/\s+/g, ' ').trim(),
      categories: item.category ?? [],
      language: item.lang ?? null,
      publishedAt: item.pubDate ?? null,
      startsAt: item.startDate ?? null,
      expiresAt: item.expirationDate ?? null,
      link: item.link ?? `${ALERT_URL}${item.guid}`,
      nearestKmFromDrossart,
      isNearIncident: nearestKmFromDrossart != null && nearestKmFromDrossart <= 40,
      geometries,
      firstRetrievedAt: generatedAt,
      lastRetrievedAt: generatedAt,
      ...cap,
    }
  }))
  const alerts = new Map((previous.alerts || []).map((alert) => [alert.guid, alert]))
  for (const alert of seen) {
    const old = alerts.get(alert.guid)
    alerts.set(alert.guid, old
      ? { ...old, ...alert, firstRetrievedAt: old.firstRetrievedAt }
      : alert)
  }
  const retained = [...alerts.values()].sort((left, right) => (
    String(right.publishedAt).localeCompare(String(left.publishedAt))
  ))
  const payload = {
    schemaVersion: 1,
    generatedAt,
    source: {
      name: 'BE-Alert public alerts (Belgian CAP gateway)',
      url: ALERT_PORTAL_URL,
      feedUrl: ALERT_FEED_URL,
      standard: 'OASIS CAP 1.2',
    },
    locationReference: { name: 'Drossart locality', ...INCIDENT },
    contextRadiusKm: 40,
    currentlyInForce: seen.map((alert) => alert.guid),
    alertCount: retained.length,
    nearIncidentCount: retained.filter((alert) => alert.isNearIncident).length,
    alerts: retained,
    interpretation: previous.interpretation || [],
  }
  const stored = await saveDataset({ key: 'public-alerts', payload }, query)
  return { itemCount: retained.length, metadata: { changed: stored.changed, inForce: seen.length } }
}

const RMI_ENDPOINT = 'https://opendata.meteo.be/service/ows'
const RMI_STATION = {
  code: 6494,
  name: 'MONT RIGI',
  latitude: 50.511,
  longitude: 6.073,
  distanceKmFromDrossart: 4.2,
}
const RMI_MEASUREMENTS = [
  { field: 'wind_speed_10m', qcKey: 'WIND_SPEED_10M', unit: 'm/s', label: 'Wind speed at 10 m' },
  { field: 'wind_direction', qcKey: 'WIND_DIRECTION', unit: 'degrees', label: 'Wind direction' },
  { field: 'wind_gusts_speed', qcKey: 'WIND_GUSTS_SPEED', unit: 'm/s', label: 'Wind gust' },
  { field: 'humidity_rel_shelter_avg', qcKey: 'HUMIDITY_REL_SHELTER_AVG', unit: '%', label: 'Relative humidity' },
  { field: 'temp_dry_shelter_avg', qcKey: 'TEMP_DRY_SHELTER_AVG', unit: 'degC', label: 'Air temperature' },
  { field: 'precip_quantity', qcKey: 'PRECIP_QUANTITY', unit: 'mm', label: 'Precipitation' },
]

function rmiQcFlags(rawValue) {
  try { return JSON.parse(rawValue ?? '{}')?.validated ?? {} } catch { return {} }
}

async function refreshRmi({ requestedAtMs, query }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const previous = await previousPayload('weather-rmi', query, { observations: [] })
  const latestStoredAt = previous.observations?.at(-1)?.observedAt
  const incrementalStartMs = Number.isFinite(Date.parse(latestStoredAt))
    ? Math.max(Date.parse(INCIDENT_START), Date.parse(latestStoredAt) - 20 * 60_000)
    : Date.parse(INCIDENT_START)
  const incrementalStart = new Date(incrementalStartMs).toISOString()
  const parameters = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: 'aws:aws_10min',
    outputFormat: 'application/json',
    count: '1000',
    sortBy: 'timestamp',
    CQL_FILTER: `code=${RMI_STATION.code} AND timestamp DURING ${incrementalStart}/${generatedAt}`,
  })
  const requestUrl = `${RMI_ENDPOINT}?${parameters}`
  const response = await fetchJson(requestUrl, { timeoutMs: 45_000 })
  const incoming = (response.features ?? []).map((feature) => {
    const properties = feature.properties ?? {}
    const validated = rmiQcFlags(properties.qc_flags)
    const record = { observedAt: properties.timestamp }
    for (const measurement of RMI_MEASUREMENTS) {
      const value = properties[measurement.field] ?? null
      record[measurement.field] = value
      record[`${measurement.field}_validated`] = value == null
        ? null
        : validated[measurement.qcKey] === true
    }
    record.wind_speed_10m_kmh = record.wind_speed_10m == null ? null : record.wind_speed_10m * 3.6
    record.wind_gusts_speed_kmh = record.wind_gusts_speed == null ? null : record.wind_gusts_speed * 3.6
    return record
  })
  if (!incoming.length) throw new Error('RMI returned no Mont Rigi observations')
  const observations = mergeRows(
    previous.observations,
    incoming,
    (row) => row.observedAt,
    (left, right) => left.observedAt.localeCompare(right.observedAt),
  )
  const selectedValues = observations.flatMap((row) => RMI_MEASUREMENTS.flatMap((measurement) => (
    row[measurement.field] == null ? [] : [row[`${measurement.field}_validated`]]
  )))
  const validatedCount = selectedValues.filter(Boolean).length
  const validationStatus = validatedCount === 0
    ? 'none-validated'
    : validatedCount === selectedValues.length ? 'fully-validated' : 'partially-validated'
  const payload = {
    schemaVersion: 1,
    generatedAt,
    source: {
      name: 'Royal Meteorological Institute of Belgium (RMI) open data',
      url: 'https://opendata.meteo.be/',
      endpoint: RMI_ENDPOINT,
      featureType: 'aws:aws_10min',
      requestUrl,
    },
    station: RMI_STATION,
    cadenceMinutes: 10,
    measurements: RMI_MEASUREMENTS,
    window: { start: INCIDENT_START, incrementalStart, end: generatedAt },
    validationStatus,
    interpretation: previous.interpretation || [],
    observations,
  }
  const stored = await saveDataset({ key: 'weather-rmi', payload }, query)
  return { itemCount: observations.length, metadata: { changed: stored.changed, validationStatus } }
}

const DWD_ROOT = 'https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes/wind'
const DWD_STATIONS = [
  { id: '15000', name: 'Aachen-Orsbach', latitude: 50.7983, longitude: 6.0244, altitudeM: 231, distanceKm: 27.9722 },
  { id: '02497', name: 'Kall-Sistig', latitude: 50.5014, longitude: 6.5264, altitudeM: 505, distanceKm: 33.5386 },
  { id: '04279', name: 'Roth bei Prüm', latitude: 50.3046, longitude: 6.3863, altitudeM: 593, distanceKm: 35.6722 },
]

function dwdTimestamp(raw) {
  const value = String(raw).trim()
  return /^\d{12}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:00Z`
    : null
}

function dwdMeasurement(raw) {
  const value = Number(String(raw).trim())
  return Number.isFinite(value) && value > -900 ? value : null
}

function parseDwdArchive(text, station, archiveKind) {
  const lines = text.trim().split(/\r?\n/)
  const headers = (lines.shift() || '').split(';').map((value) => value.trim())
  const index = Object.fromEntries(headers.map((header, position) => [header, position]))
  return lines.flatMap((line) => {
    const cells = line.split(';')
    const observedAt = dwdTimestamp(cells[index.MESS_DATUM])
    const windSpeedMs = dwdMeasurement(cells[index.FF_10])
    const windDirection = dwdMeasurement(cells[index.DD_10])
    if (!observedAt || Date.parse(observedAt) < Date.parse(INCIDENT_START)
      || windSpeedMs == null || windDirection == null) return []
    return [{
      stationId: station.id,
      observedAt,
      windSpeedMs,
      windSpeedKmh: windSpeedMs * 3.6,
      windDirection,
      qualityLevel: dwdMeasurement(cells[index.QN]),
      archiveKind,
    }]
  })
}

async function refreshDwd({ requestedAtMs, query }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const requests = DWD_STATIONS.flatMap((station) => ['recent', 'now'].map((kind) => ({
    station,
    kind,
    url: `${DWD_ROOT}/${kind}/10minutenwerte_wind_${station.id}_${kind === 'recent' ? 'akt' : 'now'}.zip`,
  })))
  const [archives, previous] = await Promise.all([
    Promise.all(requests.map(async (request) => ({ ...request, bytes: await fetchBytes(request.url, 45_000) }))),
    previousPayload('weather-dwd', query, { observations: [] }),
  ])
  const incoming = archives.flatMap((archive) => {
    const files = unzipSync(archive.bytes)
    const data = Object.entries(files).find(([name]) => /produkt.*\.txt$/i.test(name))
      || Object.entries(files).find(([name]) => /\.txt$/i.test(name))
    if (!data) throw new Error(`${archive.station.name} ${archive.kind} archive contained no text product`)
    return parseDwdArchive(strFromU8(data[1]), archive.station, archive.kind)
  })
  const observations = mergeRows(
    previous.observations,
    incoming,
    (row) => `${row.stationId}|${row.observedAt}`,
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt)
      || left.stationId.localeCompare(right.stationId),
  )
  const payload = {
    schemaVersion: 1,
    generatedAt,
    source: {
      name: 'Deutscher Wetterdienst Climate Data Center',
      url: DWD_ROOT,
      documentationUrl: `${DWD_ROOT}/DESCRIPTION_obsgermany_climate_10min_wind_en.pdf`,
    },
    locationReference: { ...INCIDENT, name: 'Drossart locality' },
    selection: { radiusKm: 40, stationCount: DWD_STATIONS.length },
    cadenceMinutes: 10,
    qualityStatus: 'preliminary',
    stations: DWD_STATIONS,
    sources: requests.map(({ station, kind, url }) => ({ stationId: station.id, archiveKind: kind, url })),
    window: { start: INCIDENT_START, end: generatedAt },
    observations,
    interpretation: previous.interpretation || [],
  }
  const stored = await saveDataset({ key: 'weather-dwd', payload }, query)
  return { itemCount: observations.length, metadata: { changed: stored.changed } }
}

export function firmsDetectionKey(detection) {
  return [
    detection.sensorKey,
    detection.satellite || 'unknown-platform',
    detection.acquiredAt,
    Number(detection.latitude).toFixed(6),
    Number(detection.longitude).toFixed(6),
  ].join('|')
}

const FIRMS_HISTORY_RECOVERY_KEY = 'migration-firms-history-20260814'
const FIRMS_HISTORY_REQUESTED_AT_MS = Date.parse('2026-08-15T12:00:00.000Z')

async function refreshFirms({ requestedAtMs, query, bucketAt }) {
  const mapKey = process.env.FIRMS_MAP_KEY?.trim()
  if (!mapKey) throw new Error('FIRMS_MAP_KEY is not configured')
  const [incoming, previous] = await Promise.all([
    loadFirms({ mapKey, requestedAtMs, includeRaw: true }),
    previousPayload('firms', query, { sensors: [], detections: [] }),
  ])
  const { rawResponses, ...incomingPayload } = incoming
  const artifacts = await archiveProviderResponses({
    sourceKey: 'firms',
    bucketAt,
    responses: rawResponses,
  }, query)
  if (!incomingPayload.sensors.length) throw new Error('Every FIRMS sensor request failed')
  const detections = mergeRows(
    previous.detections,
    incomingPayload.detections,
    firmsDetectionKey,
    (left, right) => Date.parse(left.acquiredAt) - Date.parse(right.acquiredAt)
      || left.sensorKey.localeCompare(right.sensorKey),
  )
  const summaries = new Map((previous.sensors || []).map((sensor) => [sensor.sensorKey, sensor]))
  incomingPayload.sensors.forEach((sensor) => summaries.set(sensor.sensorKey, sensor))
  const sensors = FIRMS_SENSORS.flatMap((sensor) => {
    const summary = summaries.get(sensor.key)
    if (!summary) return []
    if (sensor.providesArea) return [{ ...summary, providesArea: true, areaDerivationAllowed: true }]
    return [{
      ...summary,
      providesArea: false,
      areaDerivationAllowed: false,
      areaExclusionReason: sensor.areaExclusionReason,
      areaHa: null,
      areaMethod: null,
      areaIsEstimate: null,
      areaLabel: `${sensor.name} detections only`,
      areaDisclaimer: sensor.areaExclusionReason,
      footprintSumHa: null,
      footprintOverlapFactor: null,
      singlePixelHa: null,
      meanPixelHa: null,
      pixelInflationFactor: null,
      areaHaByConfidence: null,
      nominalPixelAreaHa: null,
      gridCellM: null,
    }]
  })
  const payload = { ...previous, ...incomingPayload, sensors, detections }
  const stored = await saveDataset({ key: 'firms', payload }, query)
  return {
    itemCount: detections.length,
    metadata: {
      changed: stored.changed,
      currentWindow: incomingPayload.detections.length,
      latestAcquiredAt: incomingPayload.latestAcquiredAt,
      healthySensors: incomingPayload.sources.filter((source) => source.ok).map((source) => source.sensorKey),
      failedSensors: incomingPayload.sources.filter((source) => !source.ok).map((source) => source.sensorKey),
      rawArtifactCount: artifacts.length,
      rawArtifacts: artifacts.map((artifact) => artifact.artifactKey),
    },
  }
}

async function refreshFirmsHistory({ requestedAtMs, query, bucketAt }) {
  const [existing, previous] = await Promise.all([
    loadDataset(FIRMS_HISTORY_RECOVERY_KEY, query),
    previousPayload('firms', query, { sensors: [], detections: [] }),
  ])
  if (existing) {
    return {
      itemCount: previous.detections?.length || 0,
      metadata: { changed: false, applied: false, ...existing.payload },
    }
  }
  const mapKey = process.env.FIRMS_MAP_KEY?.trim()
  if (!mapKey) throw new Error('FIRMS_MAP_KEY is not configured')
  const incoming = await loadFirms({
    mapKey,
    requestedAtMs: FIRMS_HISTORY_REQUESTED_AT_MS,
    includeRaw: true,
  })
  const { rawResponses, ...incomingPayload } = incoming
  const artifacts = await archiveProviderResponses({
    sourceKey: 'firms-history',
    bucketAt,
    responses: rawResponses,
  }, query)
  const failedSensors = incomingPayload.sources.filter((source) => !source.ok)
  if (failedSensors.length || incomingPayload.sensors.length !== FIRMS_SENSORS.length) {
    throw new Error(`FIRMS history recovery failed for ${failedSensors.map((source) => source.sensorKey).join(', ') || 'an incomplete sensor set'}`)
  }
  const detections = mergeRows(
    previous.detections,
    incomingPayload.detections,
    firmsDetectionKey,
    (left, right) => Date.parse(left.acquiredAt) - Date.parse(right.acquiredAt)
      || left.sensorKey.localeCompare(right.sensorKey),
  )
  const generatedAt = new Date(requestedAtMs).toISOString()
  const stored = await saveDataset({
    key: 'firms',
    payload: {
      ...previous,
      schemaVersion: previous.schemaVersion || 1,
      generatedAt,
      detections,
      latestAcquiredAt: previous.latestAcquiredAt || incomingPayload.latestAcquiredAt,
    },
  }, query)
  const recoveryPayload = {
    schemaVersion: 1,
    appliedAt: generatedAt,
    requestedWindowStart: incomingPayload.incidentDate,
    requestedDayRange: incomingPayload.dayRange,
    recoveredDetectionCount: incomingPayload.detections.length,
    newlyAddedDetectionCount: detections.length - (previous.detections?.length || 0),
    rawArtifactCount: artifacts.length,
  }
  await saveDataset({ key: FIRMS_HISTORY_RECOVERY_KEY, payload: recoveryPayload }, query)
  return {
    itemCount: detections.length,
    metadata: { changed: stored.changed, applied: true, ...recoveryPayload },
  }
}

const EFFIS_SOURCE = {
  name: 'Copernicus EFFIS near-real-time burnt area (VIIRS-derived)',
  endpoint: 'https://maps.effis.emergency.copernicus.eu/effis',
  layer: 'ms:effis.nrt.ba.poly',
  documentation: 'https://forest-fire.emergency.copernicus.eu/applications/data-and-services',
}
const EARTH_RADIUS_M = 6_371_008.8

function effisRings(geometry) {
  if (geometry.type === 'Polygon') return geometry.coordinates
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat()
  return []
}

function effisPoints(geometry) {
  return effisRings(geometry).flat()
}

function ringAreaSquareMetres(ring) {
  if (ring.length < 4) return 0
  const origin = ring.reduce((sum, coordinate) => sum + coordinate[1], 0) / ring.length
  const cosine = Math.cos(origin * Math.PI / 180)
  const points = ring.map(([longitude, latitude]) => [
    EARTH_RADIUS_M * longitude * Math.PI / 180 * cosine,
    EARTH_RADIUS_M * latitude * Math.PI / 180,
  ])
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]
    return sum + point[0] * next[1] - next[0] * point[1]
  }, 0) / 2)
}

function effisAreaHectares(geometry) {
  const polygonArea = (coordinates) => {
    const [outer, ...holes] = coordinates
    return (ringAreaSquareMetres(outer) - holes.reduce((sum, ring) => sum + ringAreaSquareMetres(ring), 0)) / 10_000
  }
  if (geometry.type === 'Polygon') return polygonArea(geometry.coordinates)
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.reduce((sum, polygon) => sum + polygonArea(polygon), 0)
  return 0
}

function effisRequestUrl(productDate) {
  const parameters = new URLSearchParams({
    SERVICE: 'WFS', VERSION: '1.1.0', REQUEST: 'GetFeature',
    TYPENAME: EFFIS_SOURCE.layer, SRSNAME: 'EPSG:4326', OUTPUTFORMAT: 'geojson',
    TIME: productDate, BBOX: '50.45,5.9,50.7,6.25,EPSG:4326',
  })
  return `${EFFIS_SOURCE.endpoint}?${parameters}`
}

async function loadEffisProduct(productDate, retrievedAt) {
  const sourceRequestUrl = effisRequestUrl(productDate)
  const collection = await fetchJson(sourceRequestUrl, {
    timeoutMs: 45_000,
    headers: { Accept: 'application/geo+json, application/json' },
  })
  const ranked = (collection.features || [])
    .filter((feature) => feature.geometry && effisPoints(feature.geometry).length)
    .map((feature) => ({
      feature,
      nearestKm: Math.min(...effisPoints(feature.geometry).map(([longitude, latitude]) => (
        haversineKm(latitude, longitude)
      ))),
    }))
    .sort((left, right) => left.nearestKm - right.nearestKm)
  const selected = ranked[0]
  if (!selected || selected.nearestKm > 10) {
    throw new Error(`No EFFIS feature was found within 10 km for ${productDate}`)
  }
  const geometry = selected.feature.geometry
  const latLonRings = effisRings(geometry).map((ring) => ring.map(([longitude, latitude]) => [latitude, longitude]))
  return {
    featureId: selected.feature.id || selected.feature.properties?.id || null,
    productDate,
    productLabel: `${productDate} daily product`,
    retrievedAt,
    source: 'Copernicus EFFIS',
    sourceEndpoint: EFFIS_SOURCE.endpoint,
    sourceRequestUrl,
    sourceUrl: EFFIS_SOURCE.documentation,
    sensor: 'VIIRS',
    nominalResolutionM: 375,
    areaHa: effisAreaHectares(geometry),
    areaMethod: 'Calculated locally from the published polygon geometry',
    labelPosition: latLonRings[0]?.[0] || [INCIDENT.latitude, INCIDENT.longitude],
    caveat: 'Automated daily VIIRS geometry; not an official affected-area estimate or field-surveyed perimeter',
    rings: latLonRings,
  }
}

async function refreshEffis({ requestedAtMs, query }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const productDate = generatedAt.slice(0, 10)
  const [product, previous] = await Promise.all([
    loadEffisProduct(productDate, generatedAt),
    previousPayload('effis', query, { products: [] }),
  ])
  const products = mergeRows(
    previous.products,
    [product],
    (item) => item.productDate,
    (left, right) => left.productDate.localeCompare(right.productDate),
  )
  const payload = { schemaVersion: 1, generatedAt, products }
  const stored = await saveDataset({ key: 'effis', payload }, query)
  return { itemCount: products.length, metadata: { changed: stored.changed, productDate } }
}

async function refreshEffisHistory({ requestedAtMs, query }) {
  const recovery = await backfillLegacyEffisHistory({ requestedAtMs, query })
  return {
    itemCount: recovery.productCount,
    metadata: { changed: recovery.applied, ...recovery },
  }
}

const EMS_LISTING = 'https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations-info/'
const EMS_DETAIL = 'https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations/?code='
const KNOWN_OTHER_INCIDENTS = { EMSR920: 'Forest fire in Huertgen Forest, Germany (separate incident)' }

function emsCentroid(wkt) {
  const match = /POINT\s*\(([-\d.]+)\s+([-\d.]+)\)/.exec(String(wkt ?? ''))
  return match ? { longitude: Number(match[1]), latitude: Number(match[2]) } : null
}

async function refreshEms({ requestedAtMs, query }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const [listing, previous] = await Promise.all([
    fetchJson(EMS_LISTING, { timeoutMs: 30_000 }),
    previousPayload('ems', query, { activations: [], matches: [] }),
  ])
  const raw = Array.isArray(listing) ? listing : (listing.results ?? [])
  const current = raw.map((activation) => {
    const centroid = emsCentroid(activation.centroid)
    return {
      code: activation.code,
      name: activation.name,
      category: activation.category,
      countries: activation.countries ?? [],
      eventTime: activation.eventTime,
      activationTime: activation.activationTime,
      lastUpdate: activation.lastUpdate,
      closed: activation.closed,
      productCount: activation.n_products,
      centroid,
      distanceKm: centroid ? haversineKm(centroid.latitude, centroid.longitude) : null,
    }
  })
  const activations = mergeRows(
    previous.activations || [...(previous.matches || []), ...(previous.nearbyActivations || [])],
    current,
    (activation) => activation.code,
    (left, right) => String(left.activationTime).localeCompare(String(right.activationTime)),
  )
  const matches = current.filter((activation) => activation.category === 'Wildfire'
    && !KNOWN_OTHER_INCIDENTS[activation.code]
    && (activation.countries.includes('Belgium') || (activation.distanceKm != null && activation.distanceKm <= 30)))
  const details = await Promise.all(matches.map(async (match) => {
    try {
      const payload = await fetchJson(`${EMS_DETAIL}${encodeURIComponent(match.code)}`, { timeoutMs: 20_000 })
      return (payload.results ?? [])[0] ?? payload
    } catch (error) {
      return { code: match.code, error: String(error?.message || error) }
    }
  }))
  const payload = {
    schemaVersion: 1,
    retrievedAt: generatedAt,
    source: { name: 'Copernicus EMS Rapid Mapping', url: 'https://mapping.emergency.copernicus.eu/activations/', listingUrl: EMS_LISTING },
    locationReference: { name: 'Drossart locality', ...INCIDENT },
    knownOtherIncidents: KNOWN_OTHER_INCIDENTS,
    activationFound: matches.length > 0,
    activations,
    matches,
    matchDetails: details,
    nearbyActivations: current.filter((activation) => activation.distanceKm != null && activation.distanceKm <= 100),
    listingCount: current.length,
    interpretation: previous.interpretation || [],
  }
  const stored = await saveDataset({ key: 'ems', payload }, query)
  return { itemCount: activations.length, metadata: { changed: stored.changed, activationFound: matches.length > 0 } }
}

const SENTINEL_CATALOGUE = 'https://catalogue.dataspace.copernicus.eu/odata/v1/Products'
const IGNITION_ISO = '2026-08-14T11:06:00.000Z'

async function archiveSentinelJson({ label, body, originalPath, capturedAt }, query) {
  const buffer = Buffer.from(JSON.stringify(body))
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const artifactKey = `sentinel2-${label}-${sha256}`
  await saveArtifact({
    artifactKey,
    sourceKey: 'sentinel2',
    originalPath,
    contentType: 'application/json',
    contentEncoding: 'identity',
    originalSize: buffer.byteLength,
    sha256,
    capturedAt,
    contentBase64: buffer.toString('base64'),
  }, query)
  return artifactKey
}

async function refreshSentinel2({ requestedAtMs, query }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const filter = [
    "Collection/Name eq 'SENTINEL-2'",
    `OData.CSC.Intersects(area=geography'SRID=4326;POINT(${INCIDENT.longitude} ${INCIDENT.latitude})')`,
    'ContentDate/Start gt 2026-07-25T00:00:00.000Z',
    "contains(Name,'MSIL2A')",
  ].join(' and ')
  const requestUrl = `${SENTINEL_CATALOGUE}?${new URLSearchParams({
    $filter: filter,
    $orderby: 'ContentDate/Start desc',
    $top: '50',
    $expand: 'Assets',
  })}`
  const [response, previous, firms, analysisSearch] = await Promise.all([
    fetchJson(requestUrl, { timeoutMs: 45_000 }),
    previousPayload('sentinel2', query, { scenes: [] }),
    previousPayload('firms', query, { detections: [] }),
    searchSentinelAnalysisScenes(requestedAtMs),
  ])
  const rawArtifacts = await Promise.all([
    archiveSentinelJson({
      label: 'copernicus-catalogue',
      body: response,
      originalPath: requestUrl,
      capturedAt: generatedAt,
    }, query),
    archiveSentinelJson({
      label: 'earth-search-catalogue',
      body: analysisSearch.body,
      originalPath: SENTINEL_EARTH_SEARCH_URL,
      capturedAt: generatedAt,
    }, query),
  ])
  const previousScenes = new Map((previous.scenes ?? []).map((scene) => [scene.name, scene]))
  const incoming = await Promise.all((response.value ?? []).map(async (product) => {
    const old = previousScenes.get(product.Name)
    const asset = (product.Assets ?? []).find((candidate) => candidate.Type === 'QUICKLOOK')
    let quicklook = old?.quicklook ?? null
    if (asset && (quicklook?.assetId !== asset.Id || !quicklook?.stored)) {
      const artifactKey = `sentinel2-quicklook-${asset.Id}`
      try {
        const bytes = await fetchBytes(asset.DownloadLink, 35_000)
        const buffer = Buffer.from(bytes)
        const sha256 = createHash('sha256').update(buffer).digest('hex')
        await saveArtifact({
          artifactKey,
          sourceKey: 'sentinel2',
          originalPath: asset.DownloadLink,
          contentType: 'image/jpeg',
          contentEncoding: 'identity',
          originalSize: buffer.byteLength,
          sha256,
          capturedAt: product.ContentDate.Start,
          contentBase64: buffer.toString('base64'),
        }, query)
        quicklook = {
          assetId: asset.Id,
          artifactKey,
          contentType: 'image/jpeg',
          byteLength: buffer.byteLength,
          sha256,
          stored: true,
          databaseUrl: `/api/sentinel-quicklook?id=${encodeURIComponent(asset.Id)}`,
          providerUrl: asset.DownloadLink,
        }
      } catch (error) {
        quicklook = {
          assetId: asset.Id,
          stored: false,
          providerUrl: asset.DownloadLink,
          error: String(error?.message || error),
        }
      }
    }
    return {
      productId: product.Id,
      name: product.Name,
      acquiredAt: product.ContentDate.Start,
      relativeOrbit: /_R(\d+)_/.exec(product.Name)?.[1] ?? null,
      platform: product.Name.slice(0, 3),
      isPostFire: Date.parse(product.ContentDate.Start) > Date.parse(IGNITION_ISO),
      quicklook,
    }
  }))
  const scenes = mergeRows(
    previous.scenes,
    incoming,
    (scene) => scene.name,
    (left, right) => Date.parse(left.acquiredAt) - Date.parse(right.acquiredAt),
  )
  const preFire = scenes.filter((scene) => !scene.isPostFire)
  const postFire = scenes.filter((scene) => scene.isPostFire)
  const previousAnalyses = previous.analyses ?? []
  // An early catalogue poll can beat the FIRMS history needed to anchor a
  // scene. Keep retrying that scene until the independent fire core exists;
  // only completed raster analyses make a post scene final.
  const analysedPostSceneIds = new Set(previousAnalyses
    .filter((analysis) => analysis.status !== 'awaiting-corroborated-core')
    .map((analysis) => analysis.postScene?.id))
  const nextPostScene = analysisSearch.postScenes.find((scene) => !analysedPostSceneIds.has(scene.id))
  let newAnalysis = null
  let attemptedAnalysisStatus = null
  if (analysisSearch.preScene && nextPostScene) {
    const sourceRasterArtifactKey = `sentinel2-analysis-raster-${nextPostScene.id}`
    let rasterStored = false
    const derived = await deriveSentinelBurnAnalysis({
      preScene: analysisSearch.preScene,
      postScene: nextPostScene,
      firmsPayload: firms,
      onRasterArchive: async (archive) => {
        await saveArtifact({
          artifactKey: sourceRasterArtifactKey,
          sourceKey: 'sentinel2',
          originalPath: nextPostScene.links?.find((link) => link.rel === 'self')?.href ?? SENTINEL_EARTH_SEARCH_URL,
          contentType: archive.contentType,
          contentEncoding: archive.contentEncoding,
          originalSize: archive.originalSize,
          sha256: archive.sha256,
          capturedAt: nextPostScene.properties?.datetime,
          contentBase64: archive.content.toString('base64'),
        }, query)
        rasterStored = true
      },
    })
    attemptedAnalysisStatus = derived.status
    if (derived.status !== 'awaiting-corroborated-core') {
      newAnalysis = {
        ...derived,
        ...(rasterStored ? { sourceRasterArtifactKey } : {}),
      }
      if (rasterStored) rawArtifacts.push(sourceRasterArtifactKey)
    }
  }
  const analyses = mergeRows(
    previousAnalyses,
    newAnalysis ? [newAnalysis] : [],
    (analysis) => analysis.postScene?.id,
    (left, right) => Date.parse(left.acquiredAt) - Date.parse(right.acquiredAt),
  )
  const gaps = scenes.slice(1).map((scene, index) => Number((
    (Date.parse(scene.acquiredAt) - Date.parse(scenes[index].acquiredAt)) / 86_400_000
  ).toFixed(2)))
  const payload = {
    schemaVersion: 2,
    retrievedAt: generatedAt,
    source: { name: 'Copernicus Data Space Ecosystem catalogue', url: SENTINEL_CATALOGUE, requestUrl },
    locationReference: { name: 'Drossart locality', ...INCIDENT },
    ignitionReportedAt: IGNITION_ISO,
    sceneCount: scenes.length,
    postFireSceneCount: postFire.length,
    storedQuicklookCount: scenes.filter((scene) => scene.quicklook?.stored).length,
    failedQuicklookCount: scenes.filter((scene) => scene.quicklook && !scene.quicklook.stored).length,
    lastPreFireScene: preFire.at(-1) ?? null,
    firstPostFireScene: postFire[0] ?? null,
    scenes,
    analyses,
    observedGapsDays: gaps,
    interpretation: previous.interpretation || [],
  }
  const stored = await saveDataset({ key: 'sentinel2', payload }, query)
  return {
    itemCount: scenes.length,
    metadata: {
      changed: stored.changed,
      postFireScenes: postFire.length,
      storedQuicklooks: payload.storedQuicklookCount,
      failedQuicklooks: payload.failedQuicklookCount,
      analysisCount: analyses.length,
      latestAnalysisStatus: analyses.at(-1)?.status ?? attemptedAnalysisStatus ?? 'awaiting-post-fire-scene',
      latestAnalysisAcquiredAt: analyses.at(-1)?.acquiredAt ?? null,
      latestAnalysisSupportCellCount: analyses.at(-1)?.supportCellCount ?? 0,
      latestAnalysisClearFraction: analyses.at(-1)?.clearFraction ?? null,
      rawArtifacts,
      rawArtifactCount: rawArtifacts.length,
    },
  }
}

export const REFRESH_SOURCES = [
  {
    key: 'incident-map-context', label: 'Nearby reservoir map context', intervalMinutes: 1440, run: refreshIncidentMapContext,
    providerUrl: 'https://www.wikidata.org/',
    coverage: 'German/English names and coordinates for the nearby Eupen, Gileppe, Robertville and Bütgenbach reservoirs; map context only, not evidence of a water pickup.',
  },
  {
    key: 'aircraft', label: 'Live incident aircraft', intervalMinutes: 5, run: refreshAircraft,
    providerUrl: 'https://airplanes.live/api-guide/',
    coverage: 'Live positions and complete available routes for aircraft observed in the incident area.',
  },
  {
    key: 'aircraft-artifacts', label: 'Retained aircraft poll recovery', intervalMinutes: 5, run: refreshAircraftArtifacts,
    directory: false,
    providerUrl: null,
    coverage: 'Reprocesses retained raw point responses without provider calls, promoting only identities with response-aircraft evidence and backfilling exact fixes',
  },
  {
    key: 'aircraft-traces', label: 'Current aircraft trace catch-up', intervalMinutes: 5, run: refreshCurrentAircraftTraces,
    directory: false,
    providerUrl: 'https://www.adsb.lol/',
    coverage: 'Current-day ADSB.lol traces for recently retained incident aircraft recover complete available incident-connected route sessions every five minutes after an incident-area qualification',
  },
  {
    key: 'aircraft-history', label: 'Completed aircraft history catch-up', intervalMinutes: 360, run: refreshHistoricalAircraftTraces,
    directory: false,
    providerUrl: 'https://globe.airplanes.live/',
    coverage: 'Previous-day Airplanes.live and ADSB.lol full traces for every retained incident aircraft; only sessions that entered the incident area are accepted, then their complete exact fixes and raw source files are retained',
  },
  {
    key: 'aircraft-route-history', label: 'Completed aircraft full-route recovery', intervalMinutes: 5, run: refreshAircraftRouteHistory,
    directory: false,
    providerUrl: 'https://globe.airplanes.live/',
    coverage: 'Resumable one-day-at-a-time recovery of complete incident-connected route sessions for aircraft already qualified in the incident area on every completed incident day',
  },
  {
    key: 'open-meteo', label: 'Open-Meteo model weather', intervalMinutes: 5, run: refreshOpenMeteo,
    providerUrl: 'https://open-meteo.com/',
    coverage: 'Hourly recent model history plus a complete 48-hour weather outlook for the incident area.',
  },
  {
    key: 'reports', label: 'Governor and BRF reports', intervalMinutes: 5, run: refreshReports,
    providerUrl: 'https://gouverneur.provincedeliege.be/actualites/incendie-dans-les-hautes-fagnes-la-phase-provinciale-declenchee',
    coverage: 'Published affected-area estimates and timestamped incident updates.',
  },
  {
    key: 'local-authority-updates', label: 'Official local-authority updates', intervalMinutes: 5, run: refreshMunicipalUpdates,
    providerUrl: 'https://www.stavelot.be/actualites',
    coverage: 'Published incident notices from nearby municipalities, emergency services and police.',
  },
  {
    key: 'vedia', label: 'Vedia incident reporting', intervalMinutes: 5, run: refreshVedia,
    providerUrl: 'https://www.vedia.be/jsonapi/node/content',
    coverage: 'Incident reporting from the regional news service.',
  },
  {
    key: 'public-alerts', label: 'BE-Alert CAP feed', intervalMinutes: 5, run: refreshAlerts,
    providerUrl: ALERT_PORTAL_URL,
    coverage: 'Public emergency alerts retained after they expire from the live feed.',
  },
  {
    key: 'rmi', label: 'RMI Mont Rigi observations', intervalMinutes: 10, run: refreshRmi,
    providerUrl: 'https://opendata.meteo.be/',
    coverage: 'Ten-minute observations from Mont Rigi; newest values may await quality validation.',
  },
  {
    key: 'rmi-radar', label: 'RMI precipitation radar', intervalMinutes: 5, run: refreshRmiRadar,
    providerUrl: 'https://www.meteo.be/en/weather/observations/precipitation/lightning',
    coverage: 'Official public precipitation-radar animation retained as georeferenced observation frames; the public product currently supplies ten-minute images.',
  },
  {
    key: 'dwd-radar-history', label: 'DWD historical precipitation radar', intervalMinutes: 5, run: refreshDwdRadarHistory,
    providerUrl: 'https://opendata.dwd.de/climate_environment/CDC/grids_germany/5_minutes/radolan/recent/',
    coverage: 'Official 1 km RADOLAN YW precipitation amounts at five-minute granularity; raw daily archives and incident-area frames are retained in PostgreSQL as each completed day is published.',
  },
  {
    key: 'dwd', label: 'DWD nearby wind stations', intervalMinutes: 10, run: refreshDwd,
    providerUrl: DWD_ROOT,
    coverage: 'Ten-minute wind observations from nearby German stations.',
  },
  {
    key: 'firms', label: 'NASA FIRMS detections', intervalMinutes: 15, run: refreshFirms,
    providerUrl: 'https://firms.modaps.eosdis.nasa.gov/',
    coverage: 'Thermal detections from VIIRS, MODIS and Meteosat.',
  },
  {
    key: 'nasa-gibs', label: 'NASA GIBS visual imagery', intervalMinutes: 30, run: refreshNasaGibs,
    providerUrl: 'https://www.earthdata.nasa.gov/data/tools/gibs',
    coverage: 'Daily VIIRS true-colour and short-wave-infrared visual context; imagery is not treated as a hotspot or perimeter measurement.',
  },
  {
    key: 'firms-history', label: 'NASA FIRMS ignition-day recovery', intervalMinutes: 360, run: refreshFirmsHistory,
    directory: false,
    providerUrl: 'https://firms.modaps.eosdis.nasa.gov/',
    coverage: 'One-time official API recovery of the missing 14 August two-day sensor window; raw responses and completion marker retained in Postgres',
  },
  {
    key: 'effis', label: 'Copernicus EFFIS activity envelope', intervalMinutes: 360, run: refreshEffis,
    providerUrl: EFFIS_SOURCE.documentation,
    coverage: 'Daily VIIRS-derived activity envelope; not an official burned-area perimeter.',
  },
  {
    key: 'effis-history-migration', label: 'Copernicus EFFIS historical-day recovery', intervalMinutes: 360, run: refreshEffisHistory,
    directory: false,
    providerUrl: EFFIS_SOURCE.documentation,
    coverage: 'Checksum-validated one-time recovery of the two pre-database daily products from the immutable project revision, archived and retained in Postgres',
  },
  {
    key: 'ems', label: 'Copernicus EMS activations', intervalMinutes: 60, run: refreshEms,
    providerUrl: 'https://mapping.emergency.copernicus.eu/activations/',
    coverage: 'Rapid Mapping activation catalogue and matching incident details when available.',
  },
  {
    key: 'sentinel2', label: 'Sentinel-2 imagery and observed change', intervalMinutes: 5, run: refreshSentinel2,
    providerUrl: 'https://dataspace.copernicus.eu/',
    coverage: 'Cloud-masked before/after change evidence from 20 m Sentinel-2 imagery.',
  },
  {
    key: 'sentinel3-frp', label: 'Sentinel-3 SLSTR NRT FRP', intervalMinutes: 30, run: refreshSentinel3Frp,
    providerUrl: 'https://dataspace.copernicus.eu/',
    coverage: 'Near-real-time SLSTR fire-radiative-power overpasses and retained public previews; catalogue records alone are not plotted as local hotspots.',
  },
  {
    key: 'sentinel1', label: 'Sentinel-1 radar acquisitions', intervalMinutes: 60, run: refreshSentinel1,
    providerUrl: 'https://dataspace.copernicus.eu/',
    coverage: 'Cloud-independent, matched-platform and matched-orbit radar acquisition pairs retained for conservative change corroboration.',
  },
  {
    key: 'cams', label: 'CAMS smoke and air quality', intervalMinutes: 60, run: refreshCams,
    providerUrl: 'https://atmosphere.copernicus.eu/',
    coverage: 'Hourly Copernicus 0.1° wildfire-only PM10 and PM2.5 model forecasts, including incident-grid values and georeferenced images; wildfire-only PM10 is experimental.',
  },
]

function registrySources() {
  return REFRESH_SOURCES
    .filter((source) => source.directory !== false)
    .map(({ run, directory, ...source }) => source)
}

export async function refreshAllSources({ requestedAtMs = Date.now() } = {}) {
  const query = databaseQuery()
  await saveDataset({
    key: 'source-registry',
    payload: {
      schemaVersion: 1,
      schedulerGranularityMinutes: 5,
      sources: registrySources(),
    },
    sourceUpdatedAt: null,
  }, query)

  const claims = await Promise.all(REFRESH_SOURCES.map(async (source) => ({
    source,
    ...await claimSourceRefresh({
      sourceKey: source.key,
      intervalMinutes: source.intervalMinutes,
      requestedAtMs,
    }, query),
  })))

  return Promise.all(claims.map(async ({ source, claimed, bucketAt }) => {
    if (!claimed) return { sourceKey: source.key, status: 'skipped', bucketAt }
    try {
      const result = await source.run({ requestedAtMs, query, bucketAt })
      await completeSourceRefresh({
        sourceKey: source.key,
        bucketAt,
        itemCount: result.itemCount,
        metadata: result.metadata,
      }, query)
      return { sourceKey: source.key, status: 'ok', bucketAt, ...result }
    } catch (error) {
      await failSourceRefresh({ sourceKey: source.key, bucketAt, error }, query)
      return { sourceKey: source.key, status: 'failed', bucketAt, error: String(error?.message || error) }
    }
  }))
}
