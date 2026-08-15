import { createHash } from 'node:crypto'

import { strFromU8, unzipSync } from 'fflate'

import { loadFirms } from '../api/firms-situation.js'
import { loadAreaReports } from '../api/live-reports.js'
import { loadAircraft, loadWeather } from '../api/live-situation.js'
import { FIRMS_SENSORS } from '../src/firmsDetections.js'
import {
  backfillLegacyFlightHistory,
  CURRENT_AIRCRAFT_TRACE_PROVIDERS,
  HISTORICAL_AIRCRAFT_TRACE_PROVIDERS,
  loadAircraftTraces,
  trackedAircraftFromObservations,
} from './aircraft-sources.mjs'
import {
  claimSourceRefresh,
  completeSourceRefresh,
  databaseQuery,
  failSourceRefresh,
  loadDataset,
  saveArtifact,
  saveDataset,
} from './database.mjs'
import {
  controlledSourceAccess,
  refreshIncidentPerimeter,
  refreshPublicOperations,
  refreshRoadEvents,
  ROAD_SOURCE_URL,
} from './controlled-sources.mjs'
import { persistFlightObservations, persistFlightPoll } from './flight-history.mjs'
import { refreshVedia } from './media-sources.mjs'
import { refreshMunicipalUpdates } from './municipal-sources.mjs'
import { archiveProviderResponses } from './source-artifacts.mjs'

const INCIDENT = { latitude: 50.54762, longitude: 6.05757 }
const INCIDENT_START = '2026-08-14T11:00:00.000Z'

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

async function refreshAircraftTraceSource({
  query,
  bucketAt,
  providers,
  date = null,
  sourceKey,
}) {
  const previous = await previousPayload('aircraft', query, { observations: [] })
  const aircraft = trackedAircraftFromObservations(previous.observations)
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

async function refreshCurrentAircraftTraces({ query, bucketAt }) {
  return refreshAircraftTraceSource({
    query,
    bucketAt,
    providers: CURRENT_AIRCRAFT_TRACE_PROVIDERS,
    sourceKey: 'aircraft-traces',
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
  const [incoming, previous] = await Promise.all([
    loadAreaReports(),
    previousPayload('reports', query, { areaReports: [] }),
  ])
  if (!incoming.ok) throw new Error('No live situation-report source succeeded')
  const areaReports = mergeAreaReports(previous.areaReports, incoming.areaReports)
  const events = mergeReportEvents(previous.events, incoming.events)
  const payload = { schemaVersion: 1, generatedAt, ...incoming, areaReports, events }
  const stored = await saveDataset({ key: 'reports', payload }, query)
  return {
    itemCount: areaReports.length + events.length,
    metadata: {
      changed: stored.changed,
      complete: incoming.complete,
      areaReportCount: areaReports.length,
      eventCount: events.length,
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

async function refreshEffis({ requestedAtMs, query }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const productDate = generatedAt.slice(0, 10)
  const parameters = new URLSearchParams({
    SERVICE: 'WFS', VERSION: '1.1.0', REQUEST: 'GetFeature',
    TYPENAME: EFFIS_SOURCE.layer, SRSNAME: 'EPSG:4326', OUTPUTFORMAT: 'geojson',
    TIME: productDate, BBOX: '50.45,5.9,50.7,6.25,EPSG:4326',
  })
  const sourceRequestUrl = `${EFFIS_SOURCE.endpoint}?${parameters}`
  const [collection, previous] = await Promise.all([
    fetchJson(sourceRequestUrl, { timeoutMs: 45_000, headers: { Accept: 'application/geo+json, application/json' } }),
    previousPayload('effis', query, { products: [] }),
  ])
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
  if (!selected || selected.nearestKm > 10) throw new Error('No EFFIS feature was found within 10 km')
  const geometry = selected.feature.geometry
  const latLonRings = effisRings(geometry).map((ring) => ring.map(([longitude, latitude]) => [latitude, longitude]))
  const product = {
    featureId: selected.feature.id || selected.feature.properties?.id || null,
    productDate,
    productLabel: `${productDate} daily product`,
    retrievedAt: generatedAt,
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
  const [response, previous] = await Promise.all([
    fetchJson(requestUrl, { timeoutMs: 45_000 }),
    previousPayload('sentinel2', query, { scenes: [] }),
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
  const gaps = scenes.slice(1).map((scene, index) => Number((
    (Date.parse(scene.acquiredAt) - Date.parse(scenes[index].acquiredAt)) / 86_400_000
  ).toFixed(2)))
  const payload = {
    schemaVersion: 1,
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
    },
  }
}

export const REFRESH_SOURCES = [
  {
    key: 'aircraft', label: 'Live incident aircraft', intervalMinutes: 5, run: refreshAircraft,
    providerUrl: 'https://airplanes.live/api-guide/',
    coverage: 'One incident-area point request to adsb.fi and ADSB.lol every five minutes, hourly Airplanes.live health checks, conservative verified-identity/GRZLY selection, exact accepted fixes and every raw response retained',
  },
  {
    key: 'aircraft-traces', label: 'Current aircraft trace catch-up', intervalMinutes: 30, run: refreshCurrentAircraftTraces,
    providerUrl: 'https://www.adsb.lol/',
    coverage: 'Current-day ADSB.lol traces for every retained incident aircraft recover exact incident-area fixes missed between five-minute live polls',
  },
  {
    key: 'aircraft-history', label: 'Completed aircraft history catch-up', intervalMinutes: 360, run: refreshHistoricalAircraftTraces,
    providerUrl: 'https://globe.airplanes.live/',
    coverage: 'Previous-day Airplanes.live and ADSB.lol full traces for every retained incident aircraft, filtered to exact fixes inside 10 km and retained with raw source files',
  },
  {
    key: 'open-meteo', label: 'Open-Meteo model weather', intervalMinutes: 5, run: refreshOpenMeteo,
    providerUrl: 'https://open-meteo.com/',
    coverage: 'Hourly model-grid temperature, humidity, wind and gust, retained on the five-minute timeline',
  },
  {
    key: 'reports', label: 'Governor and BRF reports', intervalMinutes: 5, run: refreshReports,
    providerUrl: 'https://gouverneur.provincedeliege.be/actualites/incendie-dans-les-hautes-fagnes-la-phase-provinciale-declenchee',
    coverage: 'Strict official/local affected-area reports and explicitly timestamped incident notices',
  },
  {
    key: 'local-authority-updates', label: 'Official local-authority updates', intervalMinutes: 5, run: refreshMunicipalUpdates,
    providerUrl: 'https://www.stavelot.be/actualites',
    coverage: 'Incident notices from Stavelot, Malmedy, Jalhay, Baelen, Eupen, Waimes, Bütgenbach, VHP, HLZ DG and Eifel Police, with raw responses retained',
  },
  {
    key: 'vedia', label: 'Vedia incident reporting', intervalMinutes: 5, run: refreshVedia,
    providerUrl: 'https://www.vedia.be/jsonapi/node/content',
    coverage: 'New and revised incident articles, source summaries and publication timestamps; always labelled local media',
  },
  {
    key: 'public-alerts', label: 'BE-Alert CAP feed', intervalMinutes: 5, run: refreshAlerts,
    providerUrl: ALERT_PORTAL_URL,
    coverage: 'Current CAP warnings plus every alert accumulated since collection began',
  },
  {
    key: 'road-events', label: 'Walloon DATEX II road events', intervalMinutes: 5, run: refreshRoadEvents,
    providerUrl: ROAD_SOURCE_URL,
    coverage: 'Incidents, congestion, works and closures from the official Walloon real-time road feed',
    accessKey: 'roadEvents',
  },
  {
    key: 'official-perimeter', label: 'Field-confirmed perimeter', intervalMinutes: 5, run: refreshIncidentPerimeter,
    providerUrl: null,
    coverage: 'Agency-issued GeoJSON perimeter snapshots and their raw source revisions',
    accessKey: 'officialPerimeter',
  },
  {
    key: 'public-operations', label: 'Sanitized incident operations', intervalMinutes: 5, run: refreshPublicOperations,
    providerUrl: null,
    coverage: 'Publishable dispatch, water pickup/drop, closure, evacuation and aggregate-compliance events',
    accessKey: 'publicOperations',
  },
  {
    key: 'rmi', label: 'RMI Mont Rigi observations', intervalMinutes: 10, run: refreshRmi,
    providerUrl: 'https://opendata.meteo.be/',
    coverage: 'Ten-minute official station temperature, humidity, precipitation, wind, gust and validation flags',
  },
  {
    key: 'dwd', label: 'DWD nearby wind stations', intervalMinutes: 10, run: refreshDwd,
    providerUrl: DWD_ROOT,
    coverage: 'Ten-minute wind and quality levels from three nearby German stations',
  },
  {
    key: 'firms', label: 'NASA FIRMS detections', intervalMinutes: 15, run: refreshFirms,
    providerUrl: 'https://firms.modaps.eosdis.nasa.gov/',
    coverage: 'Exact VIIRS and MODIS thermal detections plus GOES_NRT Meteosat detections with approximate viewing-geometry ground footprints from five products',
  },
  {
    key: 'effis', label: 'Copernicus EFFIS daily geometry', intervalMinutes: 360, run: refreshEffis,
    providerUrl: EFFIS_SOURCE.documentation,
    coverage: 'Nearest daily VIIRS-derived algorithmic geometry; distinct from a field perimeter',
  },
  {
    key: 'ems', label: 'Copernicus EMS activations', intervalMinutes: 60, run: refreshEms,
    providerUrl: 'https://mapping.emergency.copernicus.eu/activations/',
    coverage: 'Rapid Mapping activation catalogue and full match details when an activation appears',
  },
  {
    key: 'sentinel2', label: 'Sentinel-2 catalogue and quicklooks', intervalMinutes: 60, run: refreshSentinel2,
    providerUrl: 'https://dataspace.copernicus.eu/',
    coverage: 'L2A scene metadata plus public JPEG quicklook pixels archived in Postgres',
  },
]

function registrySources(environment = process.env) {
  const controlled = controlledSourceAccess(environment)
  return REFRESH_SOURCES.map(({ run, accessKey, ...source }) => {
    const access = accessKey ? controlled[accessKey] : null
    return {
      ...source,
      access: access
        ? {
            kind: 'controlled',
            configured: access.pullConfigured || access.pushReady,
            pullConfigured: access.pullConfigured,
            pushEndpointReady: access.pushReady,
          }
        : { kind: 'public', configured: true },
    }
  })
}

const COVERAGE_GAPS = [
  {
    key: 'walloon-live-road-events',
    status: 'access-not-supplied',
    detail: 'The official DATEX II adapter is ready, but no provider credentials or authenticated agency push has been supplied.',
  },
  {
    key: 'field-confirmed-fire-perimeter',
    status: 'access-not-supplied',
    detail: 'No fire-service or crisis-centre GeoJSON perimeter feed/export has been supplied to the ready pull/push adapter.',
  },
  {
    key: 'sanitized-suppression-operations',
    status: 'access-not-supplied',
    detail: 'No agency-approved dispatch, water pickup/drop, closure, evacuation or aggregate-compliance feed/export has been supplied.',
  },
  {
    key: 'historical-be-alert-before-collection',
    status: 'not-reconstructable-from-live-feed',
    detail: 'Alerts that expired before collection began are absent unless an external archive is supplied.',
  },
  {
    key: 'sentinel-analysis-ready-imagery',
    status: 'credentials-required',
    detail: 'Public quicklooks are retained; clipped multispectral bands and derived burn products require Copernicus Data Space OAuth credentials.',
  },
  {
    key: 'raw-cad-and-radio',
    status: 'not-public-and-potentially-sensitive',
    detail: 'Raw dispatch/CAD and tactical radio traffic are not published. Only an agency-approved sanitized export will be ingested.',
  },
  {
    key: 'evacuation-compliance-identities',
    status: 'intentionally-excluded',
    detail: 'Personal-level compliance data must not be exposed; the adapter accepts agency-approved aggregate counts only.',
  },
]

export async function refreshAllSources({ requestedAtMs = Date.now() } = {}) {
  const query = databaseQuery()
  await saveDataset({
    key: 'source-registry',
    payload: {
      schemaVersion: 1,
      schedulerGranularityMinutes: 5,
      sources: registrySources(),
      coverageGaps: COVERAGE_GAPS,
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
