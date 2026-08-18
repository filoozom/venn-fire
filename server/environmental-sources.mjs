import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { createGunzip, deflateSync, gzipSync, gunzipSync } from 'node:zlib'

import proj4 from 'proj4'

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

const DWD_RADOLAN_ARCHIVE_ROOT = 'https://opendata.dwd.de/climate_environment/CDC/grids_germany/5_minutes/radolan/recent/'
const DWD_RADOLAN_PROJECTION = '+proj=stere +lat_0=90 +lat_ts=60 +lon_0=10 +a=6370040 +b=6370040 +units=m +no_defs'
const DWD_RADOLAN_GRID = Object.freeze({
  width: 900,
  height: 900,
  cellSizeM: 1_000,
  westM: -523_462.1669,
  southM: -4_658_644.7243,
})
const DWD_RADAR_IMAGE_SIZE = Object.freeze({ width: 72, height: 56 })
const DWD_RADAR_MAX_ARCHIVES_PER_RUN = 3
const DWD_RAIN_COLORS = Object.freeze([
  [0, 0, 0, 0],
  [233, 255, 255, 144],
  [82, 255, 241, 160],
  [75, 209, 220, 192],
  [68, 162, 200, 200],
  [60, 116, 179, 216],
  [53, 69, 159, 224],
  [46, 23, 138, 232],
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

function dwdArchiveName(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error(`Invalid DWD radar archive date: ${date}`)
  return `YW-${date.slice(2).replaceAll('-', '')}.tar.gz`
}

export function dwdRadarArchiveUrl(date) {
  return new URL(dwdArchiveName(date), DWD_RADOLAN_ARCHIVE_ROOT).toString()
}

export function parseDwdRadarArchiveDates(indexHtml) {
  const dates = new Set()
  for (const match of String(indexHtml).matchAll(/YW-(\d{2})(\d{2})(\d{2})\.tar\.gz/giu)) {
    dates.add(`20${match[1]}-${match[2]}-${match[3]}`)
  }
  return [...dates].sort()
}

function dwdObservedAtFromName(fileName) {
  const match = /-(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-dwd/u.exec(fileName)
  if (!match) throw new Error(`DWD RADOLAN member has no UTC timestamp: ${fileName}`)
  const observedAt = `20${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00.000Z`
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error(`DWD RADOLAN timestamp is invalid: ${fileName}`)
  return observedAt
}

export function parseDwdRadolanYwFrame(bytes, fileName) {
  const source = Buffer.from(bytes)
  const headerEnd = source.indexOf(0x03)
  if (headerEnd < 0) throw new Error(`DWD RADOLAN header terminator is missing: ${fileName}`)
  const header = source.subarray(0, headerEnd).toString('ascii')
  if (!header.startsWith('YW')) throw new Error(`DWD radar member is not a YW product: ${fileName}`)
  const grid = /GP\s*(\d+)x\s*(\d+)/u.exec(header)
  const precisionMatch = /PR\s*E([+-]\d+)/u.exec(header)
  const intervalMatch = /INT\s*(\d+)/u.exec(header)
  if (!grid || !precisionMatch || !intervalMatch) {
    throw new Error(`DWD RADOLAN header metadata is incomplete: ${fileName}`)
  }
  // DWD documents GP as rows x columns. The incident archives use the national
  // 900 x 900, 1 km RADOLAN grid.
  const height = Number.parseInt(grid[1], 10)
  const width = Number.parseInt(grid[2], 10)
  const precisionExponent = Number.parseInt(precisionMatch[1], 10)
  const precision = 10 ** precisionExponent
  const intervalMinutes = Number.parseInt(intervalMatch[1], 10)
  const dataOffset = headerEnd + 1
  if (!width || !height || !Number.isFinite(precision) || intervalMinutes !== 5) {
    throw new Error(`DWD RADOLAN YW grid metadata is invalid: ${fileName}`)
  }
  if (source.length < dataOffset + width * height * 2) {
    throw new Error(`DWD RADOLAN YW data is truncated: ${fileName}`)
  }
  return {
    bytes: source,
    dataOffset,
    fileName,
    header,
    height,
    intervalMinutes,
    observedAt: dwdObservedAtFromName(fileName),
    precision,
    precisionDigits: Math.max(0, -precisionExponent),
    width,
  }
}

export function dwdRadolanValueMm(frame, pixelIndex) {
  if (!Number.isInteger(pixelIndex) || pixelIndex < 0 || pixelIndex >= frame.width * frame.height) return null
  const encoded = frame.bytes.readUInt16LE(frame.dataOffset + pixelIndex * 2)
  // Bits 14 and 16 mark missing and clutter values. Bit 15 is a negative
  // sign used by other RADOLAN products and is not a valid YW precipitation
  // amount. Bit 13 is only a provenance flag and does not change the value.
  if ((encoded & 0x2000) || (encoded & 0x8000) || (encoded & 0x4000)) return null
  const value = (encoded & 0x0fff) * frame.precision
  return Number(value.toFixed(frame.precisionDigits))
}

class BufferQueue {
  constructor() {
    this.chunks = []
    this.length = 0
  }

  push(chunk) {
    const bytes = Buffer.from(chunk)
    if (!bytes.length) return
    this.chunks.push(bytes)
    this.length += bytes.length
  }

  take(size) {
    if (size > this.length) return null
    const output = Buffer.allocUnsafe(size)
    let outputOffset = 0
    while (outputOffset < size) {
      const chunk = this.chunks[0]
      const length = Math.min(chunk.length, size - outputOffset)
      chunk.copy(output, outputOffset, 0, length)
      outputOffset += length
      this.length -= length
      if (length === chunk.length) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(length)
    }
    return output
  }
}

async function* tarEntriesFromGzip(gzipBytes) {
  const queue = new BufferQueue()
  const stream = Readable.from([Buffer.from(gzipBytes)]).pipe(createGunzip({ chunkSize: 2 * 1024 * 1024 }))
  let pending = null
  let ended = false
  for await (const chunk of stream) {
    queue.push(chunk)
    while (!ended) {
      if (!pending) {
        if (queue.length < 512) break
        const header = queue.take(512)
        if (header.every((value) => value === 0)) {
          ended = true
          break
        }
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '')
        const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim()
        const size = Number.parseInt(sizeText || '0', 8)
        const type = String.fromCharCode(header[156] || 0)
        if (!Number.isFinite(size) || size < 0 || size > 12 * 1024 * 1024) {
          throw new Error(`DWD radar archive member has an invalid size: ${name}`)
        }
        pending = { name, size, type, paddedSize: Math.ceil(size / 512) * 512 }
      }
      if (queue.length < pending.paddedSize) break
      const padded = queue.take(pending.paddedSize)
      const entry = pending
      pending = null
      if (entry.type === '\0' || entry.type === '0') {
        yield { name: entry.name, bytes: padded.subarray(0, entry.size) }
      }
    }
  }
  if (!ended && pending) throw new Error(`DWD radar archive ended inside member: ${pending.name}`)
}

function radolanGridPixel(longitude, latitude, frame = DWD_RADOLAN_GRID) {
  const [x, y] = proj4('EPSG:4326', DWD_RADOLAN_PROJECTION, [longitude, latitude])
  const column = Math.floor((x - DWD_RADOLAN_GRID.westM) / DWD_RADOLAN_GRID.cellSizeM)
  const row = Math.floor((y - DWD_RADOLAN_GRID.southM) / DWD_RADOLAN_GRID.cellSizeM)
  if (column < 0 || column >= frame.width || row < 0 || row >= frame.height) return null
  return { column, row, index: row * frame.width + column }
}

let dwdRadarSampleIndexes = null

function dwdRadarSamples(frame) {
  if (frame.width !== DWD_RADOLAN_GRID.width || frame.height !== DWD_RADOLAN_GRID.height) {
    throw new Error(`Unsupported DWD RADOLAN grid ${frame.height}x${frame.width}`)
  }
  if (dwdRadarSampleIndexes) return dwdRadarSampleIndexes
  const indexes = new Int32Array(DWD_RADAR_IMAGE_SIZE.width * DWD_RADAR_IMAGE_SIZE.height)
  indexes.fill(-1)
  for (let imageY = 0; imageY < DWD_RADAR_IMAGE_SIZE.height; imageY += 1) {
    const latitude = INCIDENT_AOI.north
      - (imageY + 0.5) / DWD_RADAR_IMAGE_SIZE.height * (INCIDENT_AOI.north - INCIDENT_AOI.south)
    for (let imageX = 0; imageX < DWD_RADAR_IMAGE_SIZE.width; imageX += 1) {
      const longitude = INCIDENT_AOI.west
        + (imageX + 0.5) / DWD_RADAR_IMAGE_SIZE.width * (INCIDENT_AOI.east - INCIDENT_AOI.west)
      const gridPixel = radolanGridPixel(longitude, latitude, frame)
      if (gridPixel) indexes[imageY * DWD_RADAR_IMAGE_SIZE.width + imageX] = gridPixel.index
    }
  }
  dwdRadarSampleIndexes = indexes
  return indexes
}

function dwdRainColor(valueMm) {
  if (valueMm == null || valueMm <= 0) return DWD_RAIN_COLORS[0]
  if (valueMm < 0.1) return DWD_RAIN_COLORS[1]
  if (valueMm < 0.25) return DWD_RAIN_COLORS[2]
  if (valueMm < 0.5) return DWD_RAIN_COLORS[3]
  if (valueMm < 1) return DWD_RAIN_COLORS[4]
  if (valueMm < 2) return DWD_RAIN_COLORS[5]
  if (valueMm < 4) return DWD_RAIN_COLORS[6]
  return DWD_RAIN_COLORS[7]
}

function dwdRadarIncidentMeasurement(frame) {
  const pixel = radolanGridPixel(INCIDENT_POINT.longitude, INCIDENT_POINT.latitude, frame)
  const valueMm = pixel ? dwdRadolanValueMm(frame, pixel.index) : null
  return {
    valueMm,
    unit: 'mm / 5 min',
    label: valueMm == null
      ? 'outside valid radar coverage'
      : valueMm === 0
        ? 'none detected (0.00 mm / 5 min)'
        : `${valueMm.toFixed(frame.precisionDigits)} mm / 5 min`,
    pixel: pixel ? { column: pixel.column, row: pixel.row } : null,
  }
}

function renderDwdRadarFrame(frame) {
  const samples = dwdRadarSamples(frame)
  const rgba = Buffer.alloc(samples.length * 4)
  for (let imagePixel = 0; imagePixel < samples.length; imagePixel += 1) {
    const valueMm = samples[imagePixel] < 0 ? null : dwdRadolanValueMm(frame, samples[imagePixel])
    const color = dwdRainColor(valueMm)
    const offset = imagePixel * 4
    rgba[offset] = color[0]
    rgba[offset + 1] = color[1]
    rgba[offset + 2] = color[2]
    rgba[offset + 3] = color[3]
  }
  return encodeRgbaPng(DWD_RADAR_IMAGE_SIZE.width, DWD_RADAR_IMAGE_SIZE.height, rgba)
}

async function storeDwdRadarFrames(frames, archiveUrl, query) {
  const stored = []
  const batchSize = 12
  for (let start = 0; start < frames.length; start += batchSize) {
    const batch = frames.slice(start, start + batchSize)
    stored.push(...await Promise.all(batch.map(async (frame) => {
      const image = await storeArtifact({
        artifactPrefix: 'dwd-radar-image',
        sourceKey: 'dwd-radar-history',
        originalPath: archiveUrl,
        contentType: 'image/png',
        capturedAt: frame.observedAt,
        bytes: frame.png,
        discriminator: frame.observedAt,
      }, query)
      return {
        observedAt: frame.observedAt,
        providerKey: 'dwd-radolan-yw',
        providerName: 'DWD RADOLAN YW',
        accumulationMinutes: 5,
        resolutionKm: 1,
        bounds: INCIDENT_AOI_BOUNDS,
        attribution: 'Deutscher Wetterdienst (DWD) Open Data',
        incident: frame.incident,
        image,
      }
    })))
  }
  return stored
}

async function ingestDwdRadarArchive({ date, archiveResponse, archiveUrl, query, generatedAt }) {
  const rawArtifact = await storeArtifact({
    artifactPrefix: 'dwd-radar-archive',
    sourceKey: 'dwd-radar-history',
    originalPath: archiveUrl,
    contentType: archiveResponse.contentType || 'application/gzip',
    capturedAt: generatedAt,
    bytes: archiveResponse.bytes,
    discriminator: date,
  }, query)
  const parsedFrames = []
  let archiveFrameCount = 0
  const firstIncidentBucketMs = Math.floor(Date.parse(INCIDENT_IGNITION) / 300_000) * 300_000
  for await (const entry of tarEntriesFromGzip(archiveResponse.bytes)) {
    if (!/raa01-yw_10000-\d{10}-dwd---bin$/u.test(entry.name)) continue
    const frame = parseDwdRadolanYwFrame(entry.bytes, entry.name)
    archiveFrameCount += 1
    if (frame.observedAt.slice(0, 10) !== date) {
      throw new Error(`DWD radar archive ${date} contains a frame for ${frame.observedAt.slice(0, 10)}`)
    }
    if (Date.parse(frame.observedAt) < firstIncidentBucketMs) continue
    parsedFrames.push({
      observedAt: frame.observedAt,
      incident: dwdRadarIncidentMeasurement(frame),
      png: renderDwdRadarFrame(frame),
    })
  }
  if (archiveFrameCount < 280 || archiveFrameCount > 300) {
    throw new Error(`DWD radar archive ${date} contains ${archiveFrameCount} frames; expected a complete daily archive`)
  }
  const frames = await storeDwdRadarFrames(parsedFrames, archiveUrl, query)
  return {
    frames,
    archive: {
      date,
      providerUrl: archiveUrl,
      archiveFrameCount,
      retainedFrameCount: frames.length,
      ingestedAt: generatedAt,
      rawArtifact,
    },
  }
}

function completedIncidentDatesThroughYesterday(requestedAtMs) {
  const yesterday = new Date(requestedAtMs - 86_400_000).toISOString().slice(0, 10)
  if (yesterday < INCIDENT_IGNITION.slice(0, 10)) return []
  return dateRange(INCIDENT_IGNITION.slice(0, 10), yesterday)
}

export async function refreshDwdRadarHistory({ requestedAtMs, query }) {
  const generatedAt = new Date(requestedAtMs).toISOString()
  const [index, previous] = await Promise.all([
    fetchText(DWD_RADOLAN_ARCHIVE_ROOT, { timeoutMs: 30_000 }),
    previousPayload('dwd-radar-history', query, { frames: [], archives: [], completedDates: [] }),
  ])
  const indexArtifact = await storeArtifact({
    artifactPrefix: 'dwd-radar-index',
    sourceKey: 'dwd-radar-history',
    originalPath: DWD_RADOLAN_ARCHIVE_ROOT,
    contentType: 'text/html',
    capturedAt: generatedAt,
    bytes: index.bytes,
    compress: true,
  }, query)
  const requestedDates = completedIncidentDatesThroughYesterday(requestedAtMs)
  const availableDates = new Set(parseDwdRadarArchiveDates(index.text))
  const completedDates = new Set(previous.completedDates ?? [])
  const datesToIngest = requestedDates
    .filter((date) => !completedDates.has(date) && availableDates.has(date))
    .slice(0, DWD_RADAR_MAX_ARCHIVES_PER_RUN)
  const incomingFrames = []
  const incomingArchives = []
  for (const date of datesToIngest) {
    const archiveUrl = dwdRadarArchiveUrl(date)
    const archiveResponse = await fetchResponse(archiveUrl, { timeoutMs: 40_000 })
    const ingested = await ingestDwdRadarArchive({
      date,
      archiveResponse,
      archiveUrl,
      query,
      generatedAt,
    })
    incomingFrames.push(...ingested.frames)
    incomingArchives.push(ingested.archive)
    completedDates.add(date)
  }
  const frames = mergeUnique(
    previous.frames,
    incomingFrames,
    (frame) => frame.observedAt,
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt),
  )
  const archives = mergeUnique(
    previous.archives,
    incomingArchives,
    (archive) => archive.date,
    (left, right) => left.date.localeCompare(right.date),
  )
  const pendingDates = requestedDates.filter((date) => !completedDates.has(date))
  const payload = {
    schemaVersion: 1,
    generatedAt,
    source: {
      name: 'Deutscher Wetterdienst RADOLAN YW daily archive',
      url: DWD_RADOLAN_ARCHIVE_ROOT,
    },
    cadenceMinutes: 5,
    schedulerGranularityMinutes: 5,
    resolutionKm: 1,
    accumulationMinutes: 5,
    unit: 'mm / 5 min',
    bounds: INCIDENT_AOI_BOUNDS,
    earliestObservedAt: frames[0]?.observedAt ?? null,
    latestObservedAt: frames.at(-1)?.observedAt ?? null,
    frames,
    archives,
    completedDates: [...completedDates].sort(),
    pendingDates,
    retentionPolicy: 'raw daily archives and incident-period five-minute frames retained in PostgreSQL',
  }
  const stored = await saveDataset({ key: 'dwd-radar-history', payload }, query)
  return {
    itemCount: frames.length,
    metadata: {
      changed: stored.changed,
      archiveCount: archives.length,
      completedDates: payload.completedDates,
      pendingDates,
      ingestedDates: datesToIngest,
      newFrameCount: incomingFrames.length,
      rawArtifactCount: 1 + incomingArchives.length + incomingFrames.length,
      rawArtifacts: [
        indexArtifact.artifactKey,
        ...incomingArchives.map((archive) => archive.rawArtifact.artifactKey),
      ],
    },
  }
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
        providerKey: 'rmi-public-animation',
        providerName: 'RMI public precipitation radar',
        bounds: RMI_RADAR_BOUNDS,
        attribution: 'Royal Meteorological Institute of Belgium',
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
    earliestObservedAt: frames[0]?.observedAt ?? null,
    latestObservedAt,
    frames,
    retentionPolicy: 'all public animation frames received since collection began are retained in PostgreSQL',
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
