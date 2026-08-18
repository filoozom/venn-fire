import { createHash } from 'node:crypto'
import { deflateSync, gzipSync, gunzipSync } from 'node:zlib'

import { loadDataset, saveArtifact, saveDataset } from './database.mjs'

export const INCIDENT_POINT = Object.freeze({ latitude: 50.54762, longitude: 6.05757 })
export const INCIDENT_IGNITION = '2026-08-14T11:06:00.000Z'
export const INCIDENT_AOI = Object.freeze({
  south: 50.30,
  west: 5.70,
  north: 50.80,
  east: 6.40,
})
export const INCIDENT_AOI_BOUNDS = Object.freeze([
  [INCIDENT_AOI.south, INCIDENT_AOI.west],
  [INCIDENT_AOI.north, INCIDENT_AOI.east],
])

// CAMS is a regional 0.1 degree model, not an incident-scale raster. Request a
// wider window so smoke transport has geographic context and the edge of our
// retained database image stays well outside the normal incident view. The UI
// also feathers that retained image; neither treatment changes the model data.
export const CAMS_AOI = Object.freeze({
  south: 49.50,
  west: 4.50,
  north: 51.50,
  east: 7.50,
})
export const CAMS_AOI_BOUNDS = Object.freeze([
  [CAMS_AOI.south, CAMS_AOI.west],
  [CAMS_AOI.north, CAMS_AOI.east],
])

const RMI_PAGE_URL = 'https://www.meteo.be/en/weather/observations/precipitation/lightning'
const RMI_RADAR_BOUNDS = Object.freeze([
  [48.792390196464076, 0.736083984375],
  [52.11570572480399, 7.119140625000001],
])
const RMI_RAIN_COLORS = Object.freeze([
  [0, 0, 0, 0],
  [233, 255, 255, 144],
  [82, 255, 241, 160],
  [75, 209, 220, 192],
  [68, 162, 200, 200],
  [60, 116, 179, 216],
  [53, 69, 159, 216],
  [46, 23, 138, 216],
])
const RMI_RAIN_LABELS = Object.freeze([
  'none detected',
  'drizzle',
  'very light',
  'light',
  'moderate',
  'heavy',
  'very heavy',
  'downpour or hail',
])

const GIBS_WMS_URL = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
const GIBS_LAYERS = Object.freeze([
  {
    key: 'false-color',
    name: 'VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1',
    label: 'VIIRS false colour (M11/I2/I1)',
    description: 'Short-wave infrared composite that can make active fire and burn change easier to inspect through some smoke.',
  },
  {
    key: 'true-color',
    name: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
    label: 'VIIRS true colour',
    description: 'Daily natural-colour context for smoke, cloud and visible surface change.',
  },
])

const CAMS_WMS_URL = 'https://eccharts.ecmwf.int/wms/'
const CAMS_PRODUCTS = Object.freeze([
  {
    key: 'wildfire-pm10',
    layer: 'composition_europe_pm_wf_forecast_surface',
    style: 'sh_pm_wf_web_surface_concentration',
    label: 'Wildfire-only PM10 forecast',
    modelResolutionDegrees: 0.1,
    styleMaximum: 500,
    validation: 'experimental',
  },
  {
    key: 'pm2p5',
    layer: 'composition_europe_pm2p5_forecast_surface',
    style: 'sh_pm2p5_web_surface_concentration',
    label: 'PM2.5 forecast',
    modelResolutionDegrees: 0.1,
    styleMaximum: 500,
    validation: 'regularly validated at regional scale',
  },
])

const COPERNICUS_STAC = 'https://stac.dataspace.copernicus.eu/v1'
const SENTINEL3_COLLECTION = 'sentinel-3-sl-2-frp-nrt'
const SENTINEL1_COLLECTION = 'sentinel-1-grd'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function safeArtifactPart(value) {
  return String(value ?? 'unknown').replace(/[^a-z0-9._-]+/giu, '-')
}

function sourceImageUrl(artifactKey) {
  return `/api/source-image?id=${Buffer.from(artifactKey).toString('base64url')}`
}

async function fetchResponse(url, { timeoutMs = 35_000, headers = {} } = {}) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Venn Fire Watch/1.0 (+https://apyos.com)',
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`)
  return {
    bytes,
    contentType: response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream',
  }
}

async function fetchText(url, options) {
  const response = await fetchResponse(url, options)
  return { ...response, text: response.bytes.toString('utf8') }
}

async function fetchJson(url, options) {
  const response = await fetchText(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options?.headers || {}) },
  })
  return { ...response, body: JSON.parse(response.text) }
}

async function storeArtifact({
  artifactPrefix,
  sourceKey,
  originalPath,
  contentType,
  capturedAt,
  bytes,
  compress = false,
  discriminator = '',
}, query) {
  const original = Buffer.from(bytes)
  const hash = sha256(original)
  const stored = compress ? gzipSync(original) : original
  const artifactKey = [
    artifactPrefix,
    discriminator ? safeArtifactPart(discriminator) : null,
    hash.slice(0, 24),
  ].filter(Boolean).join(':')
  await saveArtifact({
    artifactKey,
    sourceKey,
    originalPath,
    contentType,
    contentEncoding: compress ? 'gzip' : 'identity',
    originalSize: original.byteLength,
    sha256: hash,
    capturedAt,
    contentBase64: stored.toString('base64'),
  }, query)
  return {
    artifactKey,
    contentType,
    byteLength: original.byteLength,
    sha256: hash,
    databaseUrl: sourceImageUrl(artifactKey),
    providerUrl: originalPath,
  }
}

async function previousPayload(key, query, fallback) {
  return (await loadDataset(key, query))?.payload ?? fallback
}

function mergeUnique(previous, incoming, key, compare) {
  const rows = new Map()
  for (const row of [...(previous || []), ...(incoming || [])]) rows.set(key(row), row)
  return [...rows.values()].sort(compare)
}

function dateRange(startDate, endDate) {
  const rows = []
  for (let cursor = Date.parse(`${startDate}T00:00:00Z`); cursor <= Date.parse(`${endDate}T00:00:00Z`); cursor += 86_400_000) {
    rows.push(new Date(cursor).toISOString().slice(0, 10))
  }
  return rows
}

function wmsUrl(base, parameters) {
  const url = new URL(base)
  Object.entries(parameters).forEach(([key, value]) => url.searchParams.set(key, String(value)))
  return url.toString()
}

function assertImage(bytes, kind) {
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if ((kind === 'png' && !png) || (kind === 'jpeg' && !jpeg)) {
    throw new Error(`Provider returned a non-${kind.toUpperCase()} image`)
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, checksum])
}

export function encodeRgbaPng(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error('RGBA byte length does not match the image dimensions')
  const scanlines = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    const target = y * (1 + width * 4)
    scanlines[target] = 0
    rgba.copy(scanlines, target + 1, y * width * 4, (y + 1) * width * 4)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND'),
  ])
}

function readPackedPixel(bytes, startOffset, bitsPerPixel, pixelIndex) {
  const pixelInBits = pixelIndex * bitsPerPixel
  const startByte = startOffset + (pixelInBits >> 3)
  const startBit = pixelInBits & 7
  const word = ((bytes[startByte + 1] || 0) << 8) | (bytes[startByte] || 0)
  return (word >> startBit) & ((1 << bitsPerPixel) - 1)
}

export function parseRmiRadarPayload(gzipBytes) {
  const bytes = gunzipSync(gzipBytes)
  const width = bytes.readUInt16BE(0)
  const height = bytes.readUInt16BE(2)
  const bitsPerPixel = bytes[4]
  const imageCount = bytes[5]
  if (!width || !height || !imageCount || bitsPerPixel < 1 || bitsPerPixel > 8) {
    throw new Error('RMI radar payload header is invalid')
  }
  let offset = 6
  const observedTimes = Array(imageCount)
  for (let index = 0; index < imageCount; index += 1) {
    let epochSeconds = 0n
    for (let byte = 0; byte < 8; byte += 1) {
      epochSeconds += BigInt(bytes[offset]) << BigInt(byte * 8)
      offset += 1
    }
    observedTimes[imageCount - 1 - index] = new Date(Number(epochSeconds) * 1000).toISOString()
  }
  const imageSize = width * height
  const requiredBytes = offset + Math.ceil(imageCount * imageSize * bitsPerPixel / 8)
  if (bytes.length < requiredBytes) throw new Error('RMI radar payload is truncated')
  return { bytes, width, height, bitsPerPixel, imageCount, imageSize, imageOffset: offset, observedTimes }
}

function renderRmiRadarFrame(payload, imageIndex) {
  const rgba = Buffer.alloc(payload.imageSize * 4)
  const imagePixelOffset = imageIndex * payload.imageSize
  for (let pixel = 0; pixel < payload.imageSize; pixel += 1) {
    const value = readPackedPixel(payload.bytes, payload.imageOffset, payload.bitsPerPixel, imagePixelOffset + pixel)
    const color = RMI_RAIN_COLORS[value] || RMI_RAIN_COLORS[0]
    const offset = pixel * 4
    rgba[offset] = color[0]
    rgba[offset + 1] = color[1]
    rgba[offset + 2] = color[2]
    rgba[offset + 3] = color[3]
  }
  return encodeRgbaPng(payload.width, payload.height, rgba)
}

function webMercatorY(latitude) {
  const radians = latitude * Math.PI / 180
  return Math.log(Math.tan(Math.PI / 4 + radians / 2))
}

function rmiIncidentPixel(payload) {
  const [[south, west], [north, east]] = RMI_RADAR_BOUNDS
  const x = Math.max(0, Math.min(payload.width - 1, Math.round(
    payload.width * (INCIDENT_POINT.longitude - west) / (east - west),
  )))
  const southY = webMercatorY(south)
  const northY = webMercatorY(north)
  const incidentY = webMercatorY(INCIDENT_POINT.latitude)
  const y = Math.max(0, Math.min(payload.height - 1, Math.round(
    payload.height * (1 - (incidentY - southY) / (northY - southY)),
  )))
  return { x, y }
}

export function rmiRadarIncidentCategory(payload, imageIndex) {
  const { x, y } = rmiIncidentPixel(payload)
  const imagePixelOffset = imageIndex * payload.imageSize
  const value = readPackedPixel(
    payload.bytes,
    payload.imageOffset,
    payload.bitsPerPixel,
    imagePixelOffset + y * payload.width + x,
  )
  return { value, label: RMI_RAIN_LABELS[value] || 'unknown', pixel: { x, y } }
}

export async function refreshRmiRadar({ requestedAtMs, query }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const [page, previous] = await Promise.all([
    fetchText(RMI_PAGE_URL, { timeoutMs: 30_000 }),
    previousPayload('rmi-radar', query, { frames: [] }),
  ])
  const relativePayloadUrl = /fetchData\(['"]([^'"]*radar-\d{12}\.bin)['"]\)/u.exec(page.text)?.[1]
  if (!relativePayloadUrl) throw new Error('RMI public radar page did not advertise an animation payload')
  const payloadUrl = new URL(relativePayloadUrl, RMI_PAGE_URL).toString()
  const radarResponse = await fetchResponse(payloadUrl, { timeoutMs: 35_000 })
  const radar = parseRmiRadarPayload(radarResponse.bytes)
  const latestObservedAt = radar.observedTimes.at(-1)
  const rawArtifacts = await Promise.all([
    storeArtifact({
      artifactPrefix: 'rmi-radar-page',
      sourceKey: 'rmi-radar',
      originalPath: RMI_PAGE_URL,
      contentType: 'text/html',
      capturedAt: generatedAt,
      bytes: page.bytes,
      compress: true,
    }, query),
    storeArtifact({
      artifactPrefix: 'rmi-radar-source',
      sourceKey: 'rmi-radar',
      originalPath: payloadUrl,
      contentType: radarResponse.contentType || 'application/gzip',
      capturedAt: latestObservedAt,
      bytes: radarResponse.bytes,
      discriminator: latestObservedAt,
    }, query),
  ])
  const knownTimes = new Set((previous.frames || []).map((frame) => frame.observedAt))
  const newFrames = await Promise.all(radar.observedTimes.flatMap((observedAt, imageIndex) => (
    knownTimes.has(observedAt) ? [] : [Promise.resolve().then(async () => {
      const png = renderRmiRadarFrame(radar, imageIndex)
      const image = await storeArtifact({
        artifactPrefix: 'rmi-radar-image',
        sourceKey: 'rmi-radar',
        originalPath: payloadUrl,
        contentType: 'image/png',
        capturedAt: observedAt,
        bytes: png,
        discriminator: observedAt,
      }, query)
      return {
        observedAt,
        incident: rmiRadarIncidentCategory(radar, imageIndex),
        image,
      }
    })]
  )))
  const frames = mergeUnique(
    previous.frames,
    newFrames,
    (frame) => frame.observedAt,
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt),
  )
  const payload = {
    schemaVersion: 1,
    generatedAt,
    source: {
      name: 'Royal Meteorological Institute of Belgium public precipitation radar',
      url: RMI_PAGE_URL,
      payloadUrl,
    },
    cadenceMinutes: 10,
    schedulerGranularityMinutes: 5,
    bounds: RMI_RADAR_BOUNDS,
    legend: RMI_RAIN_LABELS,
    latestObservedAt,
    frames,
    retentionPolicy: 'incident lifetime in PostgreSQL',
  }
  const stored = await saveDataset({ key: 'rmi-radar', payload }, query)
  return {
    itemCount: frames.length,
    metadata: {
      changed: stored.changed,
      latestObservedAt,
      newFrameCount: newFrames.length,
      rawArtifactCount: rawArtifacts.length + newFrames.length,
      rawArtifacts: rawArtifacts.map((artifact) => artifact.artifactKey),
    },
  }
}

function gibsGetMapUrl(layer, date) {
  return wmsUrl(GIBS_WMS_URL, {
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: layer,
    styles: '',
    format: 'image/jpeg',
    crs: 'EPSG:4326',
    bbox: `${INCIDENT_AOI.south},${INCIDENT_AOI.west},${INCIDENT_AOI.north},${INCIDENT_AOI.east}`,
    width: 900,
    height: 650,
    time: date,
  })
}

export async function refreshNasaGibs({ requestedAtMs, query }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const currentDate = generatedAt.slice(0, 10)
  const previous = await previousPayload('nasa-gibs', query, { images: [] })
  const existingDates = new Set((previous.images || []).map((image) => `${image.layerKey}|${image.date}`))
  const dates = dateRange(INCIDENT_IGNITION.slice(0, 10), currentDate)
  const requests = GIBS_LAYERS.flatMap((layer) => dates.flatMap((date) => (
    date === currentDate || !existingDates.has(`${layer.key}|${date}`) ? [{ layer, date }] : []
  )))
  const incoming = await Promise.all(requests.map(async ({ layer, date }) => {
    const requestUrl = gibsGetMapUrl(layer.name, date)
    const response = await fetchResponse(requestUrl, { timeoutMs: 40_000 })
    assertImage(response.bytes, 'jpeg')
    const image = await storeArtifact({
      artifactPrefix: 'nasa-gibs-image',
      sourceKey: 'nasa-gibs',
      originalPath: requestUrl,
      contentType: 'image/jpeg',
      capturedAt: generatedAt,
      bytes: response.bytes,
      discriminator: `${layer.key}-${date}`,
    }, query)
    return { layerKey: layer.key, layerName: layer.name, label: layer.label, date, capturedAt: generatedAt, image }
  }))
  const existingImageKeys = new Set((previous.images || []).map((image) => (
    `${image.layerKey}|${image.date}|${image.image.sha256}`
  )))
  const newImages = incoming.filter((image) => !existingImageKeys.has(
    `${image.layerKey}|${image.date}|${image.image.sha256}`,
  ))
  const images = mergeUnique(
    previous.images,
    newImages,
    (image) => `${image.layerKey}|${image.date}|${image.image.sha256}`,
    (left, right) => left.date.localeCompare(right.date) || left.layerKey.localeCompare(right.layerKey)
      || Date.parse(left.capturedAt) - Date.parse(right.capturedAt),
  )
  const payload = {
    schemaVersion: 1,
    generatedAt,
    source: { name: 'NASA Global Imagery Browse Services', url: 'https://www.earthdata.nasa.gov/data/tools/gibs' },
    bounds: INCIDENT_AOI_BOUNDS,
    layers: GIBS_LAYERS,
    images,
    latestDate: currentDate,
    interpretation: 'Daily imagery is visual context, not a hotspot measurement or a burned-area perimeter.',
    retentionPolicy: 'all distinct daily image revisions in PostgreSQL',
  }
  const stored = await saveDataset({ key: 'nasa-gibs', payload }, query)
  return {
    itemCount: images.length,
    metadata: {
      changed: stored.changed,
      fetchedImageCount: incoming.length,
      newImageRevisionCount: newImages.length,
      latestDate: currentDate,
    },
  }
}

export function extractWmsLayerTime(xml, layerName) {
  const marker = `<Name>${layerName}</Name>`
  const markerIndex = xml.indexOf(marker)
  if (markerIndex < 0) throw new Error(`WMS layer ${layerName} is unavailable`)
  const start = xml.lastIndexOf('<Layer', markerIndex)
  const end = xml.indexOf('</Layer>', markerIndex)
  const block = xml.slice(start, end + '</Layer>'.length)
  const match = /<Dimension\s+name="time"[^>]*default="([^"]*)"[^>]*>([^<]+)<\/Dimension>/iu.exec(block)
    || /<Dimension\s+name="time"[^>]*>([^<]+)<\/Dimension>/iu.exec(block)
  if (!match) throw new Error(`WMS layer ${layerName} has no time dimension`)
  const defaultTime = match.length === 3 ? match[1] : null
  const values = match.length === 3 ? match[2].trim() : match[1].trim()
  return { defaultTime, values }
}

function currentCamsTime(timeDimension, requestedAtMs) {
  const parts = timeDimension.values.split(',')
  const range = parts.at(-1).split('/')
  const startMs = Date.parse(parts[0])
  const endMs = Date.parse(range.length >= 2 ? range[1] : parts.at(-1))
  const floored = Math.floor(requestedAtMs / 3_600_000) * 3_600_000
  const selected = Math.max(Number.isFinite(startMs) ? startMs : floored, Math.min(floored, Number.isFinite(endMs) ? endMs : floored))
  return new Date(selected).toISOString().replace('.000Z', 'Z')
}

function camsMapUrl(product, validAt) {
  return wmsUrl(CAMS_WMS_URL, {
    token: 'public',
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: product.layer,
    styles: product.style,
    format: 'image/png',
    transparent: 'true',
    crs: 'EPSG:4326',
    bbox: `${CAMS_AOI.south},${CAMS_AOI.west},${CAMS_AOI.north},${CAMS_AOI.east}`,
    width: 900,
    height: 650,
    time: validAt,
  })
}

function camsFeatureUrl(product, validAt) {
  const width = 900
  const height = 650
  const i = Math.round((INCIDENT_POINT.longitude - CAMS_AOI.west) / (CAMS_AOI.east - CAMS_AOI.west) * width)
  const j = Math.round((CAMS_AOI.north - INCIDENT_POINT.latitude) / (CAMS_AOI.north - CAMS_AOI.south) * height)
  return wmsUrl(CAMS_WMS_URL, {
    token: 'public',
    service: 'WMS',
    version: '1.3.0',
    request: 'GetFeatureInfo',
    layers: product.layer,
    query_layers: product.layer,
    styles: product.style,
    info_format: 'text/plain',
    crs: 'EPSG:4326',
    bbox: `${CAMS_AOI.south},${CAMS_AOI.west},${CAMS_AOI.north},${CAMS_AOI.east}`,
    width,
    height,
    i,
    j,
    time: validAt,
  })
}

export function parseCamsFeatureInfo(text) {
  const valueMatch = /^Value:\s*([-+]?\d+(?:\.\d+)?)\s*(.*)$/imu.exec(text)
  const gridLatitude = /^Grid point latitude:\s*([-+]?\d+(?:\.\d+)?)/imu.exec(text)?.[1]
  const gridLongitude = /^Grid point longitude:\s*([-+]?\d+(?:\.\d+)?)/imu.exec(text)?.[1]
  if (!valueMatch) throw new Error('CAMS feature response did not contain a numeric value')
  return {
    value: Number(valueMatch[1]),
    unit: valueMatch[2].trim().replace('µg/m3', 'µg/m³'),
    gridPoint: gridLatitude && gridLongitude ? { latitude: Number(gridLatitude), longitude: Number(gridLongitude) } : null,
  }
}

export async function refreshCams({ requestedAtMs, query }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const capabilitiesUrl = wmsUrl(CAMS_WMS_URL, {
    token: 'public', service: 'WMS', version: '1.3.0', request: 'GetCapabilities',
  })
  const [capabilities, previous] = await Promise.all([
    fetchText(capabilitiesUrl, { timeoutMs: 45_000 }),
    previousPayload('cams', query, { frames: [] }),
  ])
  const capabilitiesArtifact = await storeArtifact({
    artifactPrefix: 'cams-capabilities',
    sourceKey: 'cams',
    originalPath: capabilitiesUrl,
    contentType: 'application/xml',
    capturedAt: generatedAt,
    bytes: capabilities.bytes,
    compress: true,
  }, query)
  // Older retained frames predate per-frame bounds. Preserve the crop they were
  // actually rendered against before changing the dataset-wide default.
  const previousFrames = (previous.frames ?? []).map((frame) => ({
    ...frame,
    bounds: frame.bounds ?? previous.bounds ?? INCIDENT_AOI_BOUNDS,
  }))
  const incoming = await Promise.all(CAMS_PRODUCTS.map(async (product) => {
    const timeDimension = extractWmsLayerTime(capabilities.text, product.layer)
    const validAt = currentCamsTime(timeDimension, requestedAtMs)
    const mapUrl = camsMapUrl(product, validAt)
    const featureUrl = camsFeatureUrl(product, validAt)
    const [map, feature] = await Promise.all([
      fetchResponse(mapUrl, { timeoutMs: 40_000 }),
      fetchText(featureUrl, { timeoutMs: 40_000 }),
    ])
    assertImage(map.bytes, 'png')
    const [image, valueArtifact] = await Promise.all([
      storeArtifact({
        artifactPrefix: 'cams-image', sourceKey: 'cams', originalPath: mapUrl,
        contentType: 'image/png', capturedAt: generatedAt, bytes: map.bytes,
        discriminator: `${product.key}-${validAt}`,
      }, query),
      storeArtifact({
        artifactPrefix: 'cams-value', sourceKey: 'cams', originalPath: featureUrl,
        contentType: 'text/plain', capturedAt: generatedAt, bytes: feature.bytes, compress: true,
        discriminator: `${product.key}-${validAt}`,
      }, query),
    ])
    return {
      productKey: product.key,
      layer: product.layer,
      label: product.label,
      validAt,
      retrievedAt: generatedAt,
      bounds: CAMS_AOI_BOUNDS,
      modelResolutionDegrees: product.modelResolutionDegrees,
      styleMaximum: product.styleMaximum,
      validation: product.validation,
      point: parseCamsFeatureInfo(feature.text),
      image,
      valueArtifactKey: valueArtifact.artifactKey,
    }
  }))
  const frames = mergeUnique(
    previousFrames,
    incoming,
    (frame) => `${frame.productKey}|${frame.validAt}|${frame.image.sha256}`,
    (left, right) => Date.parse(left.validAt) - Date.parse(right.validAt)
      || left.productKey.localeCompare(right.productKey) || Date.parse(left.retrievedAt) - Date.parse(right.retrievedAt),
  )
  const payload = {
    schemaVersion: 1,
    generatedAt,
    source: { name: 'Copernicus Atmosphere Monitoring Service via ECMWF public WMS', url: 'https://atmosphere.copernicus.eu/' },
    attribution: `Generated using Copernicus Atmosphere Monitoring Service Information ${new Date(requestedAtMs).getUTCFullYear()}`,
    bounds: CAMS_AOI_BOUNDS,
    products: CAMS_PRODUCTS,
    frames,
    latestValidAt: incoming[0]?.validAt ?? null,
    interpretation: 'Hourly 0.1 degree regional-model forecast. It is not a ground sensor or fire-perimeter measurement; the wildfire-only PM10 product is experimental and the published colour style saturates at 500 µg/m³.',
    retentionPolicy: 'all distinct forecast images and incident-point values in PostgreSQL',
  }
  const stored = await saveDataset({ key: 'cams', payload }, query)
  return {
    itemCount: frames.length,
    metadata: {
      changed: stored.changed,
      latestValidAt: payload.latestValidAt,
      productValues: incoming.map((frame) => ({ productKey: frame.productKey, ...frame.point })),
      rawArtifactCount: 1 + incoming.length * 2,
      rawArtifacts: [capabilitiesArtifact.artifactKey],
    },
  }
}

function stacSearchUrl(collection, startAt, requestedAtMs) {
  const url = new URL(`${COPERNICUS_STAC}/collections/${collection}/items`)
  url.searchParams.set('bbox', '5.88,50.42,6.23,50.68')
  url.searchParams.set('datetime', `${startAt}/${new Date(requestedAtMs).toISOString()}`)
  url.searchParams.set('limit', '100')
  url.searchParams.set('sortby', '-datetime')
  return url.toString()
}

function pointInRing(longitude, latitude, ring) {
  let inside = false
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current, current += 1) {
    const [currentLongitude, currentLatitude] = ring[current]
    const [previousLongitude, previousLatitude] = ring[previous]
    if (((currentLatitude > latitude) !== (previousLatitude > latitude))
      && longitude < (previousLongitude - currentLongitude) * (latitude - currentLatitude)
        / (previousLatitude - currentLatitude) + currentLongitude) inside = !inside
  }
  return inside
}

export function geometryContainsIncident(geometry) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
    : geometry?.type === 'MultiPolygon' ? geometry.coordinates : []
  return polygons.some((polygon) => pointInRing(INCIDENT_POINT.longitude, INCIDENT_POINT.latitude, polygon[0]))
}

function publicThumbnailAsset(feature) {
  const asset = feature.assets?.thumbnail
  return asset?.href?.startsWith('https://') ? asset : null
}

async function retainedThumbnail({ sourceKey, prefix, scene, previousScene, capturedAt }, query) {
  if (previousScene?.thumbnail?.stored) return previousScene.thumbnail
  if (!scene.thumbnailProviderUrl) return null
  try {
    const response = await fetchResponse(scene.thumbnailProviderUrl, { timeoutMs: 35_000 })
    const kind = response.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'png' : 'jpeg'
    assertImage(response.bytes, kind)
    const stored = await storeArtifact({
      artifactPrefix: prefix,
      sourceKey,
      originalPath: scene.thumbnailProviderUrl,
      contentType: kind === 'png' ? 'image/png' : 'image/jpeg',
      capturedAt,
      bytes: response.bytes,
      discriminator: scene.id,
    }, query)
    return { ...stored, stored: true }
  } catch (error) {
    return { stored: false, providerUrl: scene.thumbnailProviderUrl, error: String(error?.message || error) }
  }
}

function normalizeSentinel3Scene(feature) {
  const properties = feature.properties || {}
  const thumbnail = publicThumbnailAsset(feature)
  return {
    id: feature.id,
    acquiredAt: properties.datetime || properties.start_datetime,
    completedAt: properties.end_datetime || null,
    publishedAt: properties.published || null,
    platform: properties.platform || null,
    instrument: (properties.instruments || []).join(', ') || 'SLSTR',
    nominalResolutionM: Number(properties.gsd) || 1_000,
    orbitState: properties['sat:orbit_state'] || null,
    relativeOrbit: properties['sat:relative_orbit'] ?? null,
    timeliness: properties['product:timeliness'] || null,
    thumbnailProviderUrl: thumbnail?.href || null,
  }
}

export async function refreshSentinel3Frp({ requestedAtMs, query }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const requestUrl = stacSearchUrl(SENTINEL3_COLLECTION, INCIDENT_IGNITION, requestedAtMs)
  const [response, previous] = await Promise.all([
    fetchJson(requestUrl, { timeoutMs: 45_000 }),
    previousPayload('sentinel3-frp', query, { scenes: [], detections: [] }),
  ])
  const catalogueArtifact = await storeArtifact({
    artifactPrefix: 'sentinel3-frp-catalogue', sourceKey: 'sentinel3-frp', originalPath: requestUrl,
    contentType: 'application/geo+json', capturedAt: generatedAt, bytes: response.bytes, compress: true,
  }, query)
  const previousScenes = new Map((previous.scenes || []).map((scene) => [scene.id, scene]))
  const normalized = (response.body.features || [])
    .filter((feature) => geometryContainsIncident(feature.geometry))
    .map(normalizeSentinel3Scene)
    .filter((scene) => scene.acquiredAt)
  const scenesWithThumbnails = await Promise.all(normalized.map(async (scene) => ({
    ...scene,
    thumbnail: await retainedThumbnail({
      sourceKey: 'sentinel3-frp', prefix: 'sentinel3-frp-thumbnail', scene,
      previousScene: previousScenes.get(scene.id), capturedAt: scene.acquiredAt,
    }, query),
  })))
  const scenes = mergeUnique(
    previous.scenes,
    scenesWithThumbnails,
    (scene) => scene.id,
    (left, right) => Date.parse(left.acquiredAt) - Date.parse(right.acquiredAt),
  )
  const payload = {
    schemaVersion: 1,
    generatedAt,
    source: { name: 'Copernicus Sentinel-3 SLSTR Level-2 NRT FRP', url: 'https://dataspace.copernicus.eu/' },
    product: {
      name: 'SL_2_FRP NRT',
      swirResolutionM: 500,
      mwirResolutionM: 1_000,
      role: 'near-real-time fire-radiative-power overpass catalogue and retained visual previews',
    },
    scenes,
    detections: previous.detections || [],
    latestAcquiredAt: scenes.at(-1)?.acquiredAt ?? null,
    interpretation: 'An overpass record or preview is not itself a local hotspot. Only published local FRP coordinates belong in the detection layer.',
    retentionPolicy: 'catalogue history and public previews in PostgreSQL',
  }
  const stored = await saveDataset({ key: 'sentinel3-frp', payload }, query)
  return {
    itemCount: scenes.length,
    metadata: {
      changed: stored.changed,
      latestAcquiredAt: payload.latestAcquiredAt,
      overpassCount: scenes.length,
      localDetectionCount: payload.detections.length,
      storedPreviewCount: scenes.filter((scene) => scene.thumbnail?.stored).length,
      rawArtifactCount: 1 + scenesWithThumbnails.filter((scene) => scene.thumbnail?.stored && !previousScenes.get(scene.id)?.thumbnail?.stored).length,
      rawArtifacts: [catalogueArtifact.artifactKey],
    },
  }
}

function normalizeSentinel1Scene(feature) {
  const properties = feature.properties || {}
  const thumbnail = publicThumbnailAsset(feature)
  return {
    id: feature.id,
    acquiredAt: properties.datetime || properties.start_datetime,
    completedAt: properties.end_datetime || null,
    publishedAt: properties.published || null,
    platform: properties.platform || null,
    instrumentMode: properties['sar:instrument_mode'] || null,
    polarizations: properties['sar:polarizations'] || [],
    orbitState: properties['sat:orbit_state'] || null,
    relativeOrbit: properties['sat:relative_orbit'] ?? null,
    absoluteOrbit: properties['sat:absolute_orbit'] ?? null,
    pixelSpacingM: {
      range: properties['sar:pixel_spacing_range'] ?? null,
      azimuth: properties['sar:pixel_spacing_azimuth'] ?? null,
    },
    thumbnailProviderUrl: thumbnail?.href || null,
  }
}

function sentinel1OrbitKey(scene) {
  return [scene.platform, scene.relativeOrbit, scene.orbitState].join('|')
}

export function pairSentinel1Scenes(scenes) {
  const ignitionMs = Date.parse(INCIDENT_IGNITION)
  const preScenes = scenes.filter((scene) => Date.parse(scene.acquiredAt) < ignitionMs)
  return scenes.flatMap((postScene) => {
    if (Date.parse(postScene.acquiredAt) <= ignitionMs) return []
    const preScene = preScenes
      .filter((candidate) => sentinel1OrbitKey(candidate) === sentinel1OrbitKey(postScene))
      .sort((left, right) => Date.parse(right.acquiredAt) - Date.parse(left.acquiredAt))[0]
    if (!preScene) return []
    return [{
      id: `${preScene.id}|${postScene.id}`,
      preSceneId: preScene.id,
      postSceneId: postScene.id,
      platform: postScene.platform,
      relativeOrbit: postScene.relativeOrbit,
      orbitState: postScene.orbitState,
      preAcquiredAt: preScene.acquiredAt,
      postAcquiredAt: postScene.acquiredAt,
      separationDays: Number(((Date.parse(postScene.acquiredAt) - Date.parse(preScene.acquiredAt)) / 86_400_000).toFixed(2)),
      status: 'matched-acquisition-pair',
    }]
  }).sort((left, right) => Date.parse(left.postAcquiredAt) - Date.parse(right.postAcquiredAt))
}

export async function refreshSentinel1({ requestedAtMs, query }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const searchStart = '2026-07-20T00:00:00.000Z'
  const requestUrl = stacSearchUrl(SENTINEL1_COLLECTION, searchStart, requestedAtMs)
  const [response, previous] = await Promise.all([
    fetchJson(requestUrl, { timeoutMs: 45_000 }),
    previousPayload('sentinel1', query, { scenes: [], matchedPairs: [] }),
  ])
  const catalogueArtifact = await storeArtifact({
    artifactPrefix: 'sentinel1-catalogue', sourceKey: 'sentinel1', originalPath: requestUrl,
    contentType: 'application/geo+json', capturedAt: generatedAt, bytes: response.bytes, compress: true,
  }, query)
  const previousScenes = new Map((previous.scenes || []).map((scene) => [scene.id, scene]))
  const normalized = (response.body.features || [])
    .map((feature) => {
      const scene = normalizeSentinel1Scene(feature)
      return { ...previousScenes.get(scene.id), ...scene }
    })
    .filter((scene) => scene.acquiredAt && scene.instrumentMode === 'IW')
  const baseScenes = mergeUnique(
    previous.scenes,
    normalized,
    (scene) => scene.id,
    (left, right) => Date.parse(left.acquiredAt) - Date.parse(right.acquiredAt),
  )
  const matchedPairs = pairSentinel1Scenes(baseScenes)
  const previewIds = new Set([
    ...matchedPairs.flatMap((pair) => [pair.preSceneId, pair.postSceneId]),
    ...baseScenes.slice(-4).map((scene) => scene.id),
  ])
  const scenes = await Promise.all(baseScenes.map(async (scene) => (
    previewIds.has(scene.id) ? {
      ...scene,
      thumbnail: await retainedThumbnail({
        sourceKey: 'sentinel1', prefix: 'sentinel1-thumbnail', scene,
        previousScene: previousScenes.get(scene.id), capturedAt: scene.acquiredAt,
      }, query),
    } : scene
  )))
  const payload = {
    schemaVersion: 1,
    generatedAt,
    source: { name: 'Copernicus Sentinel-1 GRD catalogue', url: 'https://dataspace.copernicus.eu/' },
    product: {
      name: 'Sentinel-1 IW GRD',
      role: 'same-platform, same-relative-orbit radar acquisition pairs for cloud-independent corroboration',
    },
    scenes,
    matchedPairs,
    changeAnalyses: previous.changeAnalyses || [],
    latestAcquiredAt: scenes.at(-1)?.acquiredAt ?? null,
    interpretation: 'Matched radar acquisitions are potential corroboration. Catalogue thumbnails are not georeferenced change measurements and do not alter the Best estimate.',
    retentionPolicy: 'catalogue history and selected public previews in PostgreSQL',
  }
  const stored = await saveDataset({ key: 'sentinel1', payload }, query)
  return {
    itemCount: scenes.length,
    metadata: {
      changed: stored.changed,
      latestAcquiredAt: payload.latestAcquiredAt,
      matchedPairCount: matchedPairs.length,
      changeAnalysisCount: payload.changeAnalyses.length,
      storedPreviewCount: scenes.filter((scene) => scene.thumbnail?.stored).length,
      rawArtifactCount: 1 + scenes.filter((scene) => scene.thumbnail?.stored && !previousScenes.get(scene.id)?.thumbnail?.stored).length,
      rawArtifacts: [catalogueArtifact.artifactKey],
    },
  }
}
