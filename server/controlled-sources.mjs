import { createHash } from 'node:crypto'

import { loadDataset, saveArtifact, saveDataset } from './database.mjs'

const INCIDENT = { latitude: 50.54762, longitude: 6.05757 }
const INCIDENT_START_MS = Date.parse('2026-08-14T11:00:00.000Z')
const MAX_SOURCE_BYTES = 5 * 1024 * 1024
const ROAD_SOURCE_URL = 'https://transportdata.be/fr/dataset/walloon-road-traffic-events/resource/1aa4fc01-4dbc-420b-945c-558e0c18342a'
const PUBLIC_OPERATION_TYPES = new Set([
  'dispatch',
  'water-pickup',
  'water-drop',
  'road-closure',
  'evacuation',
  'evacuation-compliance',
  'radio-update',
  'operation',
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

function cleanText(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function stripXmlPrefixes(xml) {
  return String(xml)
    .replace(/<(\/?)\w+:/g, '<$1')
}

function xmlValue(xml, names) {
  for (const name of names) {
    const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\/${name}>`, 'iu').exec(xml)
    if (match) return cleanText(match[1]) || null
  }
  return null
}

function stableHash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeHttpsUrl(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export function normalizeDatexRoadEvents(rawXml, retrievedAt) {
  const xml = stripXmlPrefixes(rawXml)
  const blocks = [...xml.matchAll(/<situationRecord\b([^>]*)>([\s\S]*?)<\/situationRecord>/giu)]
  return blocks.flatMap((match, index) => {
    const attributes = match[1]
    const block = match[2]
    const id = /\bid=["']([^"']+)["']/iu.exec(attributes)?.[1]
      || /\bid=["']([^"']+)["']/iu.exec(match[0])?.[1]
      || `datex-${stableHash(match[0]).slice(0, 24)}`
    const latitude = finiteNumber(xmlValue(block, ['latitude']))
    const longitude = finiteNumber(xmlValue(block, ['longitude']))
    const observedAt = xmlValue(block, [
      'situationRecordCreationTime',
      'situationRecordVersionTime',
      'overallStartTime',
    ]) || retrievedAt
    const validFrom = xmlValue(block, ['overallStartTime', 'validityTimeSpecification'])
    const validUntil = xmlValue(block, ['overallEndTime'])
    const recordType = /xsi:type=["']([^"']+)["']/iu.exec(attributes)?.[1]
      || xmlValue(block, [
        'roadOrCarriagewayOrLaneManagementType',
        'trafficElementType',
        'operatorActionType',
      ])
      || 'road-event'
    const roadName = xmlValue(block, ['roadName', 'roadNumber', 'locationDescriptor'])
    const description = xmlValue(block, [
      'comment',
      'generalPublicComment',
      'generalInstructionToRoadUsers',
      'situationRecordObservationTime',
    ])
    return [{
      id,
      recordIndex: index,
      recordType,
      observedAt,
      validFrom,
      validUntil,
      roadName,
      description,
      latitude,
      longitude,
      distanceKmFromDrossart: latitude == null || longitude == null
        ? null
        : haversineKm(latitude, longitude),
      firstRetrievedAt: retrievedAt,
      lastRetrievedAt: retrievedAt,
    }]
  })
}

function jsonCoordinates(geometry) {
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return []
  const flattened = geometry.type === 'Polygon'
    ? geometry.coordinates.flat()
    : geometry.coordinates.flat(2)
  return flattened.filter((coordinate) => (
    Array.isArray(coordinate)
      && finiteNumber(coordinate[0]) != null
      && finiteNumber(coordinate[1]) != null
  ))
}

export function normalizeIncidentPerimeter(input) {
  const features = input?.type === 'FeatureCollection'
    ? input.features
    : input?.type === 'Feature' ? [input] : [{ type: 'Feature', properties: {}, geometry: input }]
  if (!Array.isArray(features)) throw new Error('Perimeter source must be GeoJSON')
  const normalized = features.flatMap((feature, index) => {
    const coordinates = jsonCoordinates(feature?.geometry)
    if (!coordinates.length) return []
    const distances = coordinates.map(([longitude, latitude]) => haversineKm(latitude, longitude))
    if (Math.min(...distances) > 50) return []
    return [{
      type: 'Feature',
      id: feature.id ?? `perimeter-${index + 1}`,
      properties: feature.properties && typeof feature.properties === 'object' ? feature.properties : {},
      geometry: feature.geometry,
    }]
  })
  if (!normalized.length) {
    throw new Error('No Polygon or MultiPolygon within 50 km of Drossart was found')
  }
  return { type: 'FeatureCollection', features: normalized }
}

export function normalizePublicOperations(input, retrievedAt) {
  const records = Array.isArray(input) ? input : input?.events
  if (!Array.isArray(records)) throw new Error('Public operations source must contain an events array')
  return records.map((record, index) => {
    const type = String(record?.type ?? '').trim()
    const observedAt = String(record?.observedAt ?? '').trim()
    const timestampMs = Date.parse(observedAt)
    if (!PUBLIC_OPERATION_TYPES.has(type)) throw new Error(`Unsupported operation type at index ${index}`)
    if (!Number.isFinite(timestampMs) || timestampMs < INCIDENT_START_MS) {
      throw new Error(`Invalid operation timestamp at index ${index}`)
    }
    if (!String(record?.id ?? '').trim() || !String(record?.title ?? '').trim()) {
      throw new Error(`Operation id and title are required at index ${index}`)
    }
    const latitude = finiteNumber(record.latitude ?? record.position?.[0])
    const longitude = finiteNumber(record.longitude ?? record.position?.[1])
    if ((latitude == null) !== (longitude == null)) throw new Error(`Incomplete operation position at index ${index}`)
    if (latitude != null && haversineKm(latitude, longitude) > 100) {
      throw new Error(`Operation position is outside the incident region at index ${index}`)
    }
    return {
      id: String(record.id).trim(),
      observedAt: new Date(timestampMs).toISOString(),
      timestampMs,
      type,
      title: String(record.title).trim(),
      detail: String(record.detail ?? '').trim() || null,
      latitude,
      longitude,
      aggregate: record.aggregate && typeof record.aggregate === 'object' ? record.aggregate : null,
      sourceUrl: safeHttpsUrl(record.sourceUrl),
      firstRetrievedAt: retrievedAt,
      lastRetrievedAt: retrievedAt,
    }
  })
}

async function storeRawArtifact({ sourceKey, rawBody, sourceUrl, retrievedAt, contentType }, query) {
  const bytes = Buffer.from(rawBody)
  if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error(`Source payload exceeds ${MAX_SOURCE_BYTES} bytes`)
  const sha256 = stableHash(bytes)
  const artifactKey = `${sourceKey}-${sha256}`
  await saveArtifact({
    artifactKey,
    sourceKey,
    originalPath: sourceUrl,
    contentType,
    contentEncoding: 'identity',
    originalSize: bytes.byteLength,
    sha256,
    capturedAt: retrievedAt,
    contentBase64: bytes.toString('base64'),
  }, query)
  return { artifactKey, sha256, originalSize: bytes.byteLength }
}

export async function persistRoadEvents({ rawBody, retrievedAt, sourceUrl = ROAD_SOURCE_URL, ingestMode }, query) {
  const previous = (await loadDataset('road-events', query))?.payload ?? { events: [] }
  const incoming = normalizeDatexRoadEvents(rawBody, retrievedAt)
  const events = new Map((previous.events ?? []).map((event) => [event.id, event]))
  for (const event of incoming) {
    const old = events.get(event.id)
    events.set(event.id, old
      ? { ...old, ...event, firstRetrievedAt: old.firstRetrievedAt }
      : event)
  }
  const artifact = await storeRawArtifact({
    sourceKey: 'road-events', rawBody, sourceUrl, retrievedAt, contentType: 'application/xml',
  }, query)
  const retained = [...events.values()].sort((left, right) => (
    Date.parse(left.observedAt) - Date.parse(right.observedAt)
  ))
  const payload = {
    schemaVersion: 1,
    retrievedAt,
    source: {
      name: 'Walloon road traffic events',
      registryUrl: ROAD_SOURCE_URL,
      dataModel: 'DATEX II (CEN/TS 16157)',
      sourceUrl,
      access: 'Free with contract-issued username and password',
    },
    ingestMode,
    configured: true,
    currentRecordCount: incoming.length,
    eventCount: retained.length,
    events: retained,
    latestArtifact: artifact,
  }
  const stored = await saveDataset({ key: 'road-events', payload }, query)
  return { itemCount: retained.length, metadata: { changed: stored.changed, configured: true, ingestMode } }
}

export async function persistIncidentPerimeter({ rawBody, retrievedAt, sourceUrl, ingestMode }, query) {
  const parsed = JSON.parse(rawBody)
  const current = normalizeIncidentPerimeter(parsed)
  const artifact = await storeRawArtifact({
    sourceKey: 'official-perimeter', rawBody, sourceUrl, retrievedAt, contentType: 'application/geo+json',
  }, query)
  const previous = (await loadDataset('official-perimeter', query))?.payload ?? { snapshots: [] }
  const snapshot = { capturedAt: retrievedAt, sha256: artifact.sha256, artifactKey: artifact.artifactKey, featureCollection: current }
  const snapshots = new Map((previous.snapshots ?? []).map((item) => [item.sha256, item]))
  if (!snapshots.has(snapshot.sha256)) snapshots.set(snapshot.sha256, snapshot)
  const retained = [...snapshots.values()].sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt))
  const payload = {
    schemaVersion: 1,
    retrievedAt,
    source: { name: 'Field-confirmed incident perimeter', sourceUrl, access: 'Agency-issued GeoJSON feed' },
    ingestMode,
    configured: true,
    current,
    snapshotCount: retained.length,
    snapshots: retained,
    latestArtifact: artifact,
  }
  const stored = await saveDataset({ key: 'official-perimeter', payload }, query)
  return { itemCount: current.features.length, metadata: { changed: stored.changed, configured: true, ingestMode } }
}

export async function persistPublicOperations({ rawBody, retrievedAt, sourceUrl, ingestMode }, query) {
  const incoming = normalizePublicOperations(JSON.parse(rawBody), retrievedAt)
  const previous = (await loadDataset('public-operations', query))?.payload ?? { events: [] }
  const events = new Map((previous.events ?? []).map((event) => [event.id, event]))
  for (const event of incoming) {
    const old = events.get(event.id)
    events.set(event.id, old
      ? { ...old, ...event, firstRetrievedAt: old.firstRetrievedAt }
      : event)
  }
  const artifact = await storeRawArtifact({
    sourceKey: 'public-operations', rawBody, sourceUrl, retrievedAt, contentType: 'application/json',
  }, query)
  const retained = [...events.values()].sort((left, right) => left.timestampMs - right.timestampMs)
  const payload = {
    schemaVersion: 1,
    retrievedAt,
    source: {
      name: 'Sanitized public incident operations feed',
      sourceUrl,
      safetyRule: 'Publishable records only; no personal data or tactical radio content',
    },
    ingestMode,
    configured: true,
    eventCount: retained.length,
    events: retained,
    latestArtifact: artifact,
  }
  const stored = await saveDataset({ key: 'public-operations', payload }, query)
  return { itemCount: retained.length, metadata: { changed: stored.changed, configured: true, ingestMode } }
}

function pullHeaders(environment, prefix, accept) {
  const direct = environment[`${prefix}_AUTHORIZATION`]?.trim()
  const username = environment[`${prefix}_USERNAME`]?.trim()
  const password = environment[`${prefix}_PASSWORD`]?.trim()
  const authorization = direct || (username && password
    ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    : null)
  return { Accept: accept, ...(authorization ? { Authorization: authorization } : {}) }
}

async function pullBody(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(35_000) })
  const rawBody = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`)
  if (Buffer.byteLength(rawBody) > MAX_SOURCE_BYTES) throw new Error(`Source payload exceeds ${MAX_SOURCE_BYTES} bytes`)
  return rawBody
}

function unavailablePayload(datasetKey, retrievedAt) {
  if (datasetKey === 'road-events') {
    return {
      schemaVersion: 1,
      retrievedAt,
      source: {
        name: 'Walloon road traffic events',
        registryUrl: ROAD_SOURCE_URL,
        dataModel: 'DATEX II (CEN/TS 16157)',
        access: 'Awaiting contract-issued credentials',
      },
      configured: false,
      currentRecordCount: 0,
      eventCount: 0,
      events: [],
    }
  }
  if (datasetKey === 'official-perimeter') {
    return {
      schemaVersion: 1,
      retrievedAt,
      source: {
        name: 'Field-confirmed incident perimeter',
        access: 'Awaiting agency-issued GeoJSON feed',
      },
      configured: false,
      current: null,
      snapshotCount: 0,
      snapshots: [],
    }
  }
  return {
    schemaVersion: 1,
    retrievedAt,
    source: {
      name: 'Sanitized public incident operations feed',
      access: 'Awaiting agency-approved feed',
    },
    configured: false,
    eventCount: 0,
    events: [],
  }
}

async function unavailableResult(datasetKey, requestedAtMs, query) {
  const previous = await loadDataset(datasetKey, query)
  if (!previous) {
    const payload = unavailablePayload(datasetKey, new Date(requestedAtMs).toISOString())
    const stored = await saveDataset({ key: datasetKey, payload }, query)
    return {
      itemCount: 0,
      metadata: {
        changed: stored.changed,
        configured: false,
        awaitingAccess: true,
        dataAvailable: true,
      },
    }
  }
  return {
    itemCount: previous?.payload?.eventCount ?? previous?.payload?.current?.features?.length ?? 0,
    metadata: { configured: false, awaitingAccess: true, dataAvailable: Boolean(previous) },
  }
}

export async function refreshRoadEvents({ requestedAtMs, query, environment = process.env }) {
  const url = environment.WALLONIA_DATEX_URL?.trim()
  const hasCredentials = Boolean(
    environment.WALLONIA_DATEX_AUTHORIZATION?.trim()
      || (environment.WALLONIA_DATEX_USERNAME?.trim() && environment.WALLONIA_DATEX_PASSWORD?.trim()),
  )
  if (!url || !hasCredentials) return unavailableResult('road-events', requestedAtMs, query)
  const rawBody = await pullBody(url, pullHeaders(environment, 'WALLONIA_DATEX', 'application/xml, text/xml'))
  return persistRoadEvents({
    rawBody,
    retrievedAt: new Date(requestedAtMs).toISOString(),
    sourceUrl: url,
    ingestMode: 'pull',
  }, query)
}

export async function refreshIncidentPerimeter({ requestedAtMs, query, environment = process.env }) {
  const url = environment.INCIDENT_PERIMETER_URL?.trim()
  if (!url) return unavailableResult('official-perimeter', requestedAtMs, query)
  const rawBody = await pullBody(url, pullHeaders(environment, 'INCIDENT_PERIMETER', 'application/geo+json, application/json'))
  return persistIncidentPerimeter({
    rawBody,
    retrievedAt: new Date(requestedAtMs).toISOString(),
    sourceUrl: url,
    ingestMode: 'pull',
  }, query)
}

export async function refreshPublicOperations({ requestedAtMs, query, environment = process.env }) {
  const url = environment.PUBLIC_OPERATIONS_URL?.trim()
  if (!url) return unavailableResult('public-operations', requestedAtMs, query)
  const rawBody = await pullBody(url, pullHeaders(environment, 'PUBLIC_OPERATIONS', 'application/json'))
  return persistPublicOperations({
    rawBody,
    retrievedAt: new Date(requestedAtMs).toISOString(),
    sourceUrl: url,
    ingestMode: 'pull',
  }, query)
}

export function controlledSourceAccess(environment = process.env) {
  const ingestReady = Boolean(environment.CONTROLLED_SOURCE_INGEST_TOKEN?.trim())
  return {
    roadEvents: {
      pullConfigured: Boolean(environment.WALLONIA_DATEX_URL?.trim()
        && (environment.WALLONIA_DATEX_AUTHORIZATION?.trim()
          || (environment.WALLONIA_DATEX_USERNAME?.trim() && environment.WALLONIA_DATEX_PASSWORD?.trim()))),
      pushReady: ingestReady,
    },
    officialPerimeter: {
      pullConfigured: Boolean(environment.INCIDENT_PERIMETER_URL?.trim()),
      pushReady: ingestReady,
    },
    publicOperations: {
      pullConfigured: Boolean(environment.PUBLIC_OPERATIONS_URL?.trim()),
      pushReady: ingestReady,
    },
  }
}

export { MAX_SOURCE_BYTES, ROAD_SOURCE_URL }
