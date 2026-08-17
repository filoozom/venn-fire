import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

import { fromUrl } from 'geotiff'
import proj4 from 'proj4'

import { corroborateDetections } from '../src/firmsDetections.js'

export const SENTINEL_EARTH_SEARCH_URL = 'https://earth-search.aws.element84.com/v1/search'
export const SENTINEL_EARTH_SEARCH_COLLECTION = 'sentinel-2-c1-l2a'
export const SENTINEL_ANALYSIS_TILE = 'T31UGS'
export const SENTINEL_ANALYSIS_CRS = 'EPSG:32631'
export const SENTINEL_ANALYSIS_PIXEL_M = 20
export const SENTINEL_ANALYSIS_GRID_M = 50
export const SENTINEL_DNBR_THRESHOLD = 0.15
export const SENTINEL_DNBR_ANCHOR_THRESHOLD = 0.20
export const SENTINEL_CORE_DISTANCE_M = 750
export const SENTINEL_MIN_PIXELS_PER_GRID_CELL = 2
export const SENTINEL_MIN_COMPONENT_CELLS = 4

const IGNITION_ISO = '2026-08-14T11:06:00.000Z'
const IGNITION_MS = Date.parse(IGNITION_ISO)
const SEARCH_START_ISO = '2026-07-25T00:00:00.000Z'
const INCIDENT = { latitude: 50.54762, longitude: 6.05757 }

// This is deliberately wider than the displayed incident extent. It leaves room
// for a genuine Sentinel change lobe to extend the estimate, while the separate
// distance-to-corroborated-core rule prevents unrelated change elsewhere in the
// crop from entering it.
export const SENTINEL_ANALYSIS_BBOX = Object.freeze([5.88, 50.42, 6.23, 50.68])

const VALID_SURFACE_SCL = new Set([4, 5]) // vegetation and not-vegetated

function metresPerDegreeLatitude(latitude) {
  const phi = (latitude * Math.PI) / 180
  return 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi)
}

function metresPerDegreeLongitude(latitude) {
  const phi = (latitude * Math.PI) / 180
  return 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi)
}

function localGridProjection(origin = INCIDENT) {
  return {
    anchorLat: origin.latitude,
    anchorLon: origin.longitude,
    mPerLat: metresPerDegreeLatitude(origin.latitude),
    mPerLon: metresPerDegreeLongitude(origin.latitude),
  }
}

function itemAcquiredAt(item) {
  return item?.properties?.datetime || item?.properties?.start_datetime || null
}

function hasAnalysisAssets(item) {
  return ['nir08', 'swir22', 'scl'].every((key) => item?.assets?.[key]?.href)
}

function sceneSummary(item) {
  return {
    id: item.id,
    acquiredAt: itemAcquiredAt(item),
    cloudCoverPercent: Number(item.properties?.['eo:cloud_cover']),
    tile: SENTINEL_ANALYSIS_TILE,
    platform: item.properties?.platform ?? null,
    stacUrl: item.links?.find((link) => link.rel === 'self')?.href ?? null,
  }
}

function projectedBounds(wgs84Bounds) {
  const [west, south, east, north] = wgs84Bounds
  const corners = [
    [west, south], [west, north], [east, south], [east, north],
  ].map((position) => proj4('EPSG:4326', SENTINEL_ANALYSIS_CRS, position))
  return [
    Math.min(...corners.map(([x]) => x)),
    Math.min(...corners.map(([, y]) => y)),
    Math.max(...corners.map(([x]) => x)),
    Math.max(...corners.map(([, y]) => y)),
  ]
}

function assetTransform(asset) {
  const transform = asset?.['proj:transform']
  if (!Array.isArray(transform) || transform.length < 6) {
    throw new Error('Sentinel COG asset is missing its projected transform')
  }
  return transform.slice(0, 6).map(Number)
}

function rasterWindow(asset, projectedBbox) {
  const [resX, , originX, , resY, originY] = assetTransform(asset)
  const shape = asset?.['proj:shape']
  if (!Array.isArray(shape) || shape.length !== 2 || !resX || !resY) {
    throw new Error('Sentinel COG asset is missing its projected shape')
  }
  const raw = [
    Math.round((projectedBbox[0] - originX) / resX),
    Math.round((projectedBbox[1] - originY) / resY),
    Math.round((projectedBbox[2] - originX) / resX),
    Math.round((projectedBbox[3] - originY) / resY),
  ]
  const width = Number(shape[1])
  const height = Number(shape[0])
  return {
    window: [
      Math.max(0, Math.min(raw[0], raw[2])),
      Math.max(0, Math.min(raw[1], raw[3])),
      Math.min(width, Math.max(raw[0], raw[2])),
      Math.min(height, Math.max(raw[1], raw[3])),
    ],
    resX,
    resY,
    originX,
    originY,
  }
}

async function readCogWindow(asset, window, signal) {
  const tiff = await fromUrl(asset.href, {}, signal)
  const image = await tiff.getImage()
  const rasters = await image.readRasters({ window, samples: [0], signal })
  return rasters[0]
}

function reflectance(value, asset) {
  const band = asset?.['raster:bands']?.[0] ?? {}
  const scale = Number.isFinite(Number(band.scale)) ? Number(band.scale) : 0.0001
  const offset = Number.isFinite(Number(band.offset)) ? Number(band.offset) : 0
  return Number(value) * scale + offset
}

function normalizedBurnRatio(nir, swir) {
  const denominator = nir + swir
  return denominator > 0 ? (nir - swir) / denominator : null
}

function coreSpatialIndex(corePositions, cellSize = SENTINEL_CORE_DISTANCE_M) {
  const index = new Map()
  for (const [x, y] of corePositions) {
    const key = `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`
    const positions = index.get(key) ?? []
    positions.push([x, y])
    index.set(key, positions)
  }
  return index
}

function distanceToIndexedCore(x, y, index, cellSize = SENTINEL_CORE_DISTANCE_M) {
  const cellX = Math.floor(x / cellSize)
  const cellY = Math.floor(y / cellSize)
  let nearestSquared = Infinity
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (const position of index.get(`${cellX + offsetX}:${cellY + offsetY}`) ?? []) {
        nearestSquared = Math.min(nearestSquared, (x - position[0]) ** 2 + (y - position[1]) ** 2)
      }
    }
  }
  return Math.sqrt(nearestSquared)
}

function gridCellForWgs84(longitude, latitude, projection, gridCellM = SENTINEL_ANALYSIS_GRID_M) {
  const x = (longitude - projection.anchorLon) * projection.mPerLon
  const y = (latitude - projection.anchorLat) * projection.mPerLat
  return [Math.floor(x / gridCellM), Math.floor(y / gridCellM)]
}

function cellKey([x, y]) {
  return `${x}:${y}`
}

function parseCellKey(key) {
  return key.split(':').map(Number)
}

export function connectedGridComponents(cells) {
  const remaining = new Set(cells.map((cell) => Array.isArray(cell) ? cellKey(cell) : cell))
  const components = []
  while (remaining.size) {
    const [first] = remaining
    remaining.delete(first)
    const queue = [first]
    const component = []
    while (queue.length) {
      const key = queue.pop()
      component.push(key)
      const [x, y] = parseCellKey(key)
      for (const neighbour of [`${x - 1}:${y}`, `${x + 1}:${y}`, `${x}:${y - 1}`, `${x}:${y + 1}`]) {
        if (!remaining.delete(neighbour)) continue
        queue.push(neighbour)
      }
    }
    components.push(component)
  }
  return components.sort((left, right) => right.length - left.length)
}

export function selectSentinelSupportCells(cellStats, {
  minPixels = SENTINEL_MIN_PIXELS_PER_GRID_CELL,
  anchorThreshold = SENTINEL_DNBR_ANCHOR_THRESHOLD,
  minComponentCells = SENTINEL_MIN_COMPONENT_CELLS,
} = {}) {
  const candidates = [...cellStats]
    .filter(([, value]) => value.count >= minPixels && value.maxDnbr >= anchorThreshold)
    .map(([key]) => key)
  return connectedGridComponents(candidates)
    .filter((component) => component.length >= minComponentCells)
    .flatMap((component) => component.map(parseCellKey))
    .sort((left, right) => left[1] - right[1] || left[0] - right[0])
}

function signedArea(ring) {
  let area = 0
  for (let index = 0; index < ring.length; index += 1) {
    const [x1, y1] = ring[index]
    const [x2, y2] = ring[(index + 1) % ring.length]
    area += x1 * y2 - x2 * y1
  }
  return area / 2
}

function pointInRing([x, y], ring) {
  let inside = false
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current, current += 1) {
    const [currentX, currentY] = ring[current]
    const [previousX, previousY] = ring[previous]
    const crosses = (currentY > y) !== (previousY > y)
      && x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX
    if (crosses) inside = !inside
  }
  return inside
}

function traceGridRings(cells) {
  const occupied = new Set(cells.map(cellKey))
  const edges = new Map()
  const addEdge = (fromX, fromY, toX, toY) => {
    const key = `${fromX}:${fromY}`
    const outgoing = edges.get(key) ?? []
    outgoing.push([toX, toY])
    edges.set(key, outgoing)
  }
  for (const key of occupied) {
    const [x, y] = parseCellKey(key)
    if (!occupied.has(`${x}:${y - 1}`)) addEdge(x, y, x + 1, y)
    if (!occupied.has(`${x + 1}:${y}`)) addEdge(x + 1, y, x + 1, y + 1)
    if (!occupied.has(`${x}:${y + 1}`)) addEdge(x + 1, y + 1, x, y + 1)
    if (!occupied.has(`${x - 1}:${y}`)) addEdge(x, y + 1, x, y)
  }

  const rings = []
  while (edges.size) {
    const [startKey] = edges.keys()
    const start = parseCellKey(startKey)
    const ring = []
    let current = start
    while (true) {
      const key = cellKey(current)
      const outgoing = edges.get(key)
      if (!outgoing?.length) break
      const next = outgoing.pop()
      if (!outgoing.length) edges.delete(key)
      ring.push(current)
      current = next
      if (current[0] === start[0] && current[1] === start[1]) break
    }
    if (ring.length < 4) continue
    const simplified = ring.filter((point, index) => {
      const previous = ring[(index - 1 + ring.length) % ring.length]
      const next = ring[(index + 1) % ring.length]
      return (point[0] - previous[0]) * (next[1] - point[1])
        - (point[1] - previous[1]) * (next[0] - point[0]) !== 0
    })
    if (simplified.length >= 4) rings.push(simplified)
  }
  return rings
}

export function dissolveGridCellsToMultiPolygon(cells, {
  origin = INCIDENT,
  gridCellM = SENTINEL_ANALYSIS_GRID_M,
} = {}) {
  if (!cells.length) return { type: 'MultiPolygon', coordinates: [] }
  const projection = localGridProjection(origin)
  const rings = traceGridRings(cells)
  const outers = rings.filter((ring) => signedArea(ring) > 0).map((ring) => ({ ring, holes: [] }))
  const holes = rings.filter((ring) => signedArea(ring) < 0)
  for (const hole of holes) {
    const point = hole[0]
    const containing = outers
      .filter((outer) => pointInRing(point, outer.ring))
      .sort((left, right) => Math.abs(signedArea(left.ring)) - Math.abs(signedArea(right.ring)))[0]
    if (containing) containing.holes.push(hole)
  }

  const toLonLat = ([x, y]) => [
    projection.anchorLon + (x * gridCellM) / projection.mPerLon,
    projection.anchorLat + (y * gridCellM) / projection.mPerLat,
  ]
  const closed = (ring) => [...ring.map(toLonLat), toLonLat(ring[0])]
  return {
    type: 'MultiPolygon',
    coordinates: outers.map(({ ring, holes: innerRings }) => [closed(ring), ...innerRings.map(closed)]),
  }
}

export async function searchSentinelAnalysisScenes(requestedAtMs) {
  const response = await fetch(SENTINEL_EARTH_SEARCH_URL, {
    method: 'POST',
    headers: { Accept: 'application/geo+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collections: [SENTINEL_EARTH_SEARCH_COLLECTION],
      bbox: [INCIDENT.longitude - 0.001, INCIDENT.latitude - 0.001, INCIDENT.longitude + 0.001, INCIDENT.latitude + 0.001],
      datetime: `${SEARCH_START_ISO}/${new Date(requestedAtMs).toISOString()}`,
      limit: 100,
      sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(`HTTP ${response.status} from Earth Search`)
  const items = (body.features ?? [])
    .filter((item) => item.id.includes(SENTINEL_ANALYSIS_TILE) && hasAnalysisAssets(item))
    .sort((left, right) => Date.parse(itemAcquiredAt(left)) - Date.parse(itemAcquiredAt(right)))
  const preScene = items.filter((item) => Date.parse(itemAcquiredAt(item)) < IGNITION_MS).at(-1) ?? null
  const postScenes = items.filter((item) => Date.parse(itemAcquiredAt(item)) >= IGNITION_MS)
  return { body, preScene, postScenes }
}

function buildRasterArchive({
  preScene,
  postScene,
  arrays,
  window,
  width,
  height,
  transform,
}) {
  const names = ['pre-b8a', 'pre-b12', 'pre-scl', 'post-b8a', 'post-b12', 'post-scl']
  const assets = [
    preScene.assets.nir08,
    preScene.assets.swir22,
    preScene.assets.scl,
    postScene.assets.nir08,
    postScene.assets.swir22,
    postScene.assets.scl,
  ]
  const header = Buffer.from(`${JSON.stringify({
    format: 'venn-fire-sentinel-raster-v1',
    byteOrder: 'little-endian',
    crs: SENTINEL_ANALYSIS_CRS,
    width,
    height,
    window,
    transform,
    preScene: sceneSummary(preScene),
    postScene: sceneSummary(postScene),
    bands: arrays.map((array, index) => ({
      name: names[index],
      dataType: array.constructor.name,
      byteLength: array.byteLength,
      sourceUrl: assets[index].href,
      rasterBand: assets[index]['raster:bands']?.[0] ?? null,
    })),
  })}\n`)
  const parts = [header, ...arrays.map((array) => (
    Buffer.from(array.buffer, array.byteOffset, array.byteLength)
  ))]
  const original = Buffer.concat(parts)
  return {
    content: gzipSync(original, { level: 6 }),
    originalSize: original.byteLength,
    sha256: createHash('sha256').update(original).digest('hex'),
    contentType: 'application/vnd.venn-fire.sentinel-raster+binary',
    contentEncoding: 'gzip',
  }
}

export async function deriveSentinelBurnAnalysis({
  preScene,
  postScene,
  firmsPayload,
  onRasterArchive = null,
}) {
  if (!preScene || !postScene) throw new Error('A pre-fire and post-fire Sentinel scene are required')
  const postAcquiredAt = itemAcquiredAt(postScene)
  const fireCore = corroborateDetections(firmsPayload?.detections ?? [])
    .filter((detection) => detection.isFireCore && Date.parse(detection.acquiredAt) <= Date.parse(postAcquiredAt))
  const corePositions = fireCore.map((detection) => (
    proj4('EPSG:4326', SENTINEL_ANALYSIS_CRS, [detection.longitude, detection.latitude])
  ))
  if (!corePositions.length) {
    return {
      schemaVersion: 1,
      status: 'awaiting-corroborated-core',
      generatedAt: new Date().toISOString(),
      preScene: sceneSummary(preScene),
      postScene: sceneSummary(postScene),
      acquiredAt: postAcquiredAt,
      supportCells: [],
      geometry: { type: 'MultiPolygon', coordinates: [] },
    }
  }

  const projectedBbox = projectedBounds(SENTINEL_ANALYSIS_BBOX)
  const referenceAsset = postScene.assets.nir08
  const referenceWindow = rasterWindow(referenceAsset, projectedBbox)
  const { window, resX, resY, originX, originY } = referenceWindow
  if (Math.abs(resX) !== SENTINEL_ANALYSIS_PIXEL_M || Math.abs(resY) !== SENTINEL_ANALYSIS_PIXEL_M) {
    throw new Error(`Unexpected Sentinel analysis resolution ${resX} x ${resY}`)
  }
  const requiredAssets = [
    preScene.assets.nir08,
    preScene.assets.swir22,
    preScene.assets.scl,
    postScene.assets.nir08,
    postScene.assets.swir22,
    postScene.assets.scl,
  ]
  for (const asset of requiredAssets) {
    const candidateWindow = rasterWindow(asset, projectedBbox).window
    if (candidateWindow.some((value, index) => value !== window[index])) {
      throw new Error('Pre-fire and post-fire Sentinel rasters are not grid-aligned')
    }
  }

  const signal = AbortSignal.timeout(50_000)
  const [preNir, preSwir, preScl, postNir, postSwir, postScl] = await Promise.all(
    requiredAssets.map((asset) => readCogWindow(asset, window, signal)),
  )
  const width = window[2] - window[0]
  const height = window[3] - window[1]
  if (onRasterArchive) {
    await onRasterArchive(buildRasterArchive({
      preScene,
      postScene,
      arrays: [preNir, preSwir, preScl, postNir, postSwir, postScl],
      window,
      width,
      height,
      transform: [resX, 0, originX, 0, resY, originY],
    }))
  }
  const coreIndex = coreSpatialIndex(corePositions)
  const projection = localGridProjection(INCIDENT)
  const stats = new Map()
  let clearPixelCount = 0
  let thresholdPixelCount = 0
  let coreQualifiedPixelCount = 0

  for (let index = 0; index < preNir.length; index += 1) {
    if (!VALID_SURFACE_SCL.has(preScl[index]) || !VALID_SURFACE_SCL.has(postScl[index])) continue
    const preNirValue = reflectance(preNir[index], preScene.assets.nir08)
    const preSwirValue = reflectance(preSwir[index], preScene.assets.swir22)
    const postNirValue = reflectance(postNir[index], postScene.assets.nir08)
    const postSwirValue = reflectance(postSwir[index], postScene.assets.swir22)
    if ([preNirValue, preSwirValue, postNirValue, postSwirValue].some((value) => value <= 0)) continue
    const preNbr = normalizedBurnRatio(preNirValue, preSwirValue)
    const postNbr = normalizedBurnRatio(postNirValue, postSwirValue)
    if (preNbr == null || postNbr == null) continue
    clearPixelCount += 1
    const dnbr = preNbr - postNbr
    if (dnbr < SENTINEL_DNBR_THRESHOLD) continue
    thresholdPixelCount += 1

    const column = index % width
    const row = Math.floor(index / width)
    const projectedX = originX + (window[0] + column + 0.5) * resX
    const projectedY = originY + (window[1] + row + 0.5) * resY
    if (distanceToIndexedCore(projectedX, projectedY, coreIndex) > SENTINEL_CORE_DISTANCE_M) continue
    coreQualifiedPixelCount += 1
    const [longitude, latitude] = proj4(SENTINEL_ANALYSIS_CRS, 'EPSG:4326', [projectedX, projectedY])
    const key = cellKey(gridCellForWgs84(longitude, latitude, projection))
    const cell = stats.get(key) ?? { count: 0, sumDnbr: 0, maxDnbr: -Infinity }
    cell.count += 1
    cell.sumDnbr += dnbr
    cell.maxDnbr = Math.max(cell.maxDnbr, dnbr)
    stats.set(key, cell)
  }

  const supportCells = selectSentinelSupportCells(stats)
  const geometry = dissolveGridCellsToMultiPolygon(supportCells)
  return {
    schemaVersion: 1,
    status: supportCells.length ? 'ready' : 'no-qualified-change',
    generatedAt: new Date().toISOString(),
    acquiredAt: postAcquiredAt,
    preScene: sceneSummary(preScene),
    postScene: sceneSummary(postScene),
    source: {
      name: 'Sentinel-2 Collection 1 L2A Cloud-Optimized GeoTIFFs',
      catalogue: 'Element 84 Earth Search',
      catalogueUrl: 'https://earth-search.aws.element84.com/v1/',
      registryUrl: 'https://registry.opendata.aws/sentinel-2-l2a-cogs/',
      originalMission: 'Copernicus Sentinel-2',
    },
    method: {
      index: 'dNBR = pre-fire NBR - post-fire NBR; NBR = (B8A - B12) / (B8A + B12)',
      inputResolutionM: SENTINEL_ANALYSIS_PIXEL_M,
      estimateGridM: SENTINEL_ANALYSIS_GRID_M,
      dnbrThreshold: SENTINEL_DNBR_THRESHOLD,
      anchorThreshold: SENTINEL_DNBR_ANCHOR_THRESHOLD,
      validSclClasses: [...VALID_SURFACE_SCL],
      minimumPixelsPerGridCell: SENTINEL_MIN_PIXELS_PER_GRID_CELL,
      minimumConnectedGridCells: SENTINEL_MIN_COMPONENT_CELLS,
      maximumCorroboratedCoreDistanceM: SENTINEL_CORE_DISTANCE_M,
      rule: 'Cloud-clear vegetation/non-vegetation pixels only; at least two 20 m dNBR pixels per 50 m cell, one at dNBR >= 0.20, a four-cell connected component, and every accepted pixel within 750 m of the independently corroborated VIIRS core.',
    },
    bounds: SENTINEL_ANALYSIS_BBOX,
    gridOrigin: INCIDENT,
    rasterWidth: width,
    rasterHeight: height,
    rasterPixelCount: width * height,
    clearPixelCount,
    clearFraction: width * height ? clearPixelCount / (width * height) : 0,
    thresholdPixelCount,
    coreQualifiedPixelCount,
    observedChangeAreaHa: Number((coreQualifiedPixelCount * SENTINEL_ANALYSIS_PIXEL_M ** 2 / 10_000).toFixed(2)),
    fireCorePointCount: corePositions.length,
    candidateGridCellCount: stats.size,
    supportCellCount: supportCells.length,
    supportAreaHa: Number((supportCells.length * SENTINEL_ANALYSIS_GRID_M ** 2 / 10_000).toFixed(2)),
    supportCells,
    geometry,
    caveats: [
      'Positive dNBR is spectral change consistent with fire effects; it is not a field-confirmed burned-area perimeter or severity class.',
      'Cloud, cirrus, shadow, smoke and SCL uncertainty leave much of a scene unobserved. Missing change is never treated as unburned ground.',
      'The Sentinel result can add positive evidence to the combined estimate but cannot erase newer thermal or aircraft-supported evidence.',
    ],
  }
}
