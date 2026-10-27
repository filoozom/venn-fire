import sharp from 'sharp'
import proj4 from 'proj4'
import { setImmediate as yieldToIo } from 'node:timers/promises'
import { windFrameAt } from '../src/data.js'
import { aircraftTraceOpacity, fadingObservationPaths, visibleAircraftObservations } from '../src/aircraftTracks.js'
import { firmsDetectionOpacityAt } from '../src/firmsDetections.js'
import { bestEstimateAt, environmentalStateAt, footprintOriginFor, rasterOverlaysAt } from '../src/mapState.js'
import { FIRMS_CONFIDENCE_STYLE } from '../src/mapStyles.js'
import { xml } from './wms.mjs'

function projection(crs) {
  return proj4('EPSG:4326', crs === 'CRS:84' ? 'EPSG:4326' : crs)
}

export function pixelPosition(position, request) {
  const [x, y] = projection(request.crs).forward([position[1], position[0]])
  const [west, south, east, north] = request.bbox
  return [(x - west) / (east - west) * request.width, (north - y) / (north - south) * request.height]
}

function svgDrawing(request) {
  const project = projection(request.crs)
  const [west, south, east, north] = request.bbox
  const point = (position) => {
    if (!position?.every(Number.isFinite)) return null
    const [x, y] = project.forward([position[1], position[0]])
    const result = [(x - west) / (east - west) * request.width, (north - y) / (north - south) * request.height]
    return result.every(Number.isFinite) ? result : null
  }
  const path = (rings, { color, weight = 1, opacity = 1, fillOpacity = 0, dash = '', closed = true } = {}) => {
    const d = rings.map((ring) => {
      const points = ring.map(point).filter(Boolean)
      return points.length < 2 ? '' : `M${points.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join('L')}${closed ? 'Z' : ''}`
    }).join('')
    return `<path d="${d}" stroke="${xml(color)}" stroke-width="${weight}" stroke-opacity="${opacity}" fill="${fillOpacity ? xml(color) : 'none'}" fill-opacity="${fillOpacity}" fill-rule="evenodd" stroke-dasharray="${dash}" stroke-linejoin="round"/>`
  }
  const marker = (position, content, opacity = 1, rotation = 0) => {
    const p = point(position)
    if (!p || p[0] < -40 || p[0] > request.width + 40 || p[1] < -40 || p[1] > request.height + 40) return ''
    return `<g transform="translate(${p[0]},${p[1]}) rotate(${Number.isFinite(rotation) ? rotation : 0})" opacity="${opacity}">${content}</g>`
  }
  const circle = (position, radius, style) => marker(position, `<circle r="${radius}" stroke="${xml(style.color)}" stroke-width="${style.weight}" stroke-opacity="${style.opacity}" fill="${xml(style.color)}" fill-opacity="${style.fillOpacity}"/>`)
  return { path, marker, circle }
}

// Inverse-map output pixel centres into the retained crop's actual projection.
// Nearest-neighbour sampling preserves the discrete radar categories and palette.
async function geographicPixels(request, signal) {
  const target = projection(request.crs)
  const [west, south, east, north] = request.bbox
  const positions = new Float64Array(request.width * request.height * 2)
  for (let y = 0; y < request.height; y += 1) {
    if (signal && y % 64 === 0) { await yieldToIo(); signal.throwIfAborted() }
    const outputY = north - (y + 0.5) / request.height * (north - south)
    for (let x = 0; x < request.width; x += 1) {
      const point = target.inverse([west + (x + 0.5) / request.width * (east - west), outputY])
      const offset = (y * request.width + x) * 2
      positions[offset] = point[0]
      positions[offset + 1] = point[1]
    }
  }
  return positions
}

export async function reprojectRaster(bytes, overlay, request, projectionCache = {}, signal) {
  signal?.throwIfAborted()
  const { data, info } = await sharp(bytes, { limitInputPixels: 16_777_216 }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const source = projection(overlay.crs)
  const target = projection(request.crs)
  const [[south, west], [north, east]] = overlay.bounds
  const [left, bottom] = source.forward([west, south])
  const [right, top] = source.forward([east, north])
  if (![left, bottom, right, top].every(Number.isFinite) || right <= left || top <= bottom) throw new Error('Invalid retained image bounds')
  const rgba = Buffer.alloc(request.width * request.height * 4)
  if (!data.some((value, index) => index % 4 === 3 && value > 0)) {
    return sharp(rgba, { raw: { width: request.width, height: request.height, channels: 4 } }).png().toBuffer()
  }
  const [minX, minY, maxX, maxY] = request.bbox
  // Lambert couples both axes; geographic/Mercator retain the cheaper axis lookup.
  const separable = !['EPSG:31370', 'EPSG:3812'].includes(request.crs)
  // A combined map shares this bounded grid across its retained image layers.
  const positions = separable ? null : (projectionCache.geographic ??= await geographicPixels(request, signal))
  const columns = new Int32Array(request.width)
  const rows = new Int32Array(request.height)
  for (let x = 0; separable && x < request.width; x += 1) {
    const outputX = minX + (x + 0.5) / request.width * (maxX - minX)
    const longitude = target.inverse([outputX, 0])[0]
    columns[x] = Math.floor((source.forward([longitude, 0])[0] - left) / (right - left) * info.width)
  }
  for (let y = 0; separable && y < request.height; y += 1) {
    const outputY = maxY - (y + 0.5) / request.height * (maxY - minY)
    const latitude = target.inverse([0, outputY])[1]
    const sourceY = source.forward([0, latitude])[1]
    rows[y] = Number.isFinite(sourceY) ? Math.floor((top - sourceY) / (top - bottom) * info.height) : -1
  }
  for (let y = 0; y < request.height; y += 1) {
    if (signal && y % 64 === 0) { await yieldToIo(); signal.throwIfAborted() }
    if (separable && (rows[y] < 0 || rows[y] >= info.height)) continue
    for (let x = 0; x < request.width; x += 1) {
      let sourceX = columns[x], sourceY = rows[y]
      if (!separable) {
        const offset = (y * request.width + x) * 2
        const point = [positions[offset], positions[offset + 1]]
        const [sx, sy] = overlay.crs === 'EPSG:4326' ? point : source.forward(point)
        sourceX = Math.floor((sx - left) / (right - left) * info.width)
        sourceY = Math.floor((top - sy) / (top - bottom) * info.height)
      }
      if (!Number.isFinite(sourceX) || !Number.isFinite(sourceY) || sourceX < 0 || sourceX >= info.width || sourceY < 0 || sourceY >= info.height) continue
      const input = (sourceY * info.width + sourceX) * 4
      const output = (y * request.width + x) * 4
      let alpha = overlay.opacity
      if (overlay.sourceKey === 'cams') {
        const radius = Math.hypot((sourceX + 0.5) / info.width * 2 - 1, (sourceY + 0.5) / info.height * 2 - 1) / Math.SQRT2
        alpha *= radius <= 0.58 ? 1 : radius <= 0.75 ? 1 - (radius - 0.58) / 0.17 * 0.28 : Math.max(0, (1 - radius) / 0.25 * 0.72)
      }
      rgba[output] = data[input]
      rgba[output + 1] = data[input + 1]
      rgba[output + 2] = data[input + 2]
      rgba[output + 3] = Math.round(data[input + 3] * alpha)
    }
  }
  return sharp(rgba, { raw: { width: request.width, height: request.height, channels: 4 } }).png().toBuffer()
}

function vectorLayer(layer, bundle, state, request, draw) {
  const { runtime, flights, detections } = bundle
  const time = request.timestampMs
  const { path, marker, circle } = draw
  switch (layer.type) {
    case 'protected':
      return path([runtime.protectedArea], { color: '#698867', weight: 1, opacity: 0.48, fillOpacity: 0.04, dash: '5 6' })
    case 'effis': {
      const product = state.currentEffisArea
      return product?.displayOpacity > 0 ? path(product.rings, { color: '#d48b3a', weight: 2.4, opacity: 0.9 * product.displayOpacity, fillOpacity: 0.07 * product.displayOpacity, dash: '8 5' }) : ''
    }
    case 'sentinel2':
      return state.sentinelBurnGeometry.features.map((feature) => {
        const polygons = feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : [feature.geometry.coordinates]
        return polygons.map((polygon) => path(polygon.map((ring) => ring.map(([lon, lat]) => [lat, lon])), {
          color: '#765093', weight: 1.15, opacity: 0.88 * feature.properties.displayOpacity, fillOpacity: 0.22 * feature.properties.displayOpacity,
        })).join('')
      }).join('')
    case 'sentinel3':
      return state.visibleSentinel3Detections.map((detection) => circle([Number(detection.latitude), Number(detection.longitude)], 5, {
        color: '#9f2f73', weight: 1.2, opacity: 0.9 * detection.displayOpacity, fillOpacity: 0.3 * detection.displayOpacity,
      })).join('')
    case 'firms':
      return detections.filter((row) => row.sensorKey === layer.sensorKey && (!layer.confidence || row.confidence.label === layer.confidence))
        .map((row) => {
          const opacity = firmsDetectionOpacityAt(row, time)
          if (opacity <= 0) return ''
          const base = FIRMS_CONFIDENCE_STYLE[row.confidence.label] ?? FIRMS_CONFIDENCE_STYLE.unknown
          const computed = row.footprintSource === 'computed-geostationary'
          const style = { ...base, opacity: base.opacity * opacity, fillOpacity: computed ? Math.min(0.035, base.fillOpacity * opacity) : base.fillOpacity * opacity, dash: computed ? '6 5' : '' }
          return row.displayMode === 'centroid' ? circle(row.position, 4 + Math.max(0, row.confidence.rank ?? 0), style) : path([row.footprint], style)
        }).join('')
    case 'estimate': {
      const { fireActivityAreas } = bestEstimateAt({
        detections: detections.filter((row) => row.timestampMs <= time),
        sentinelAnalyses: state.visibleSentinelAnalyses,
        flights,
        timestampMs: time,
        origin: footprintOriginFor(runtime),
      })
      return path(fireActivityAreas.burned.rings, { color: '#111714', weight: 2.4, opacity: 0.94 })
        + path(fireActivityAreas.recent.rings, { color: '#ff2f26', weight: 2.8, opacity: 0.98 })
    }
    case 'aircraft':
      return flights.map((flight) => {
        const observations = visibleAircraftObservations(flight.observations, time)
        if (!observations.length) return flight.observations?.length ? '' : path([flight.points ?? []], { color: flight.color, weight: 2, opacity: 0.72, dash: '4 5', closed: false })
        const latest = observations.at(-1)
        const tracks = fadingObservationPaths(observations, time).map((segment) => path([segment.observations.map((row) => row.position)], {
          color: flight.color, weight: 2.2, opacity: 0.78 * segment.opacity, dash: '5 6', closed: false,
        })).join('')
        const symbol = `<path d="M0 -10 L3 -2 L10 2 V4 L3 2 V8 L5 10 L0 9 L-5 10 L-3 8 V2 L-10 4 V2 L-3 -2 Z" fill="${xml(flight.color)}" stroke="white" stroke-width="1"/>`
        return tracks + marker(latest.position, symbol, aircraftTraceOpacity(latest.timestampMs, time), latest.trackDegrees ?? 0)
      }).join('')
    case 'wind': {
      const frame = windFrameAt(runtime, time)
      const wind = layer.key === 'wind' ? frame.drossartWind : layer.key === 'rmiWind' ? frame.montRigiWind : frame.dwdWinds.find((row) => row.id === layer.stationId)
      if (!wind || Date.parse(wind.observedAt) > time || !Number.isFinite(wind.windDirection)) return ''
      const color = layer.key === 'wind' ? '#72b7e6' : layer.key === 'rmiWind' ? '#8fd7c7' : '#b9a0e8'
      return marker(wind.position, `<circle r="16" fill="white" fill-opacity="0.8"/><path d="M0 10 V-10 M-6 -3 L0 -10 L6 -3" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`, 1, wind.windDirection + 180)
    }
    default: throw new Error(`Unsupported vector layer type: ${layer.type}`)
  }
}

export async function renderMap(bundle, request, loadImage, signal) {
  signal?.throwIfAborted()
  const state = environmentalStateAt(bundle.runtime, request.timestampMs)
  const overlays = rasterOverlaysAt(bundle.runtime, state)
  const draw = svgDrawing(request)
  const composites = []
  const projectionCache = {}
  let svg = ''
  const flushVectors = () => {
    if (!svg) return
    composites.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${request.width}" height="${request.height}">${svg}</svg>`) })
    svg = ''
  }
  for (const layer of request.layers) {
    signal?.throwIfAborted()
    if (layer.type !== 'raster') {
      svg += vectorLayer(layer, bundle, state, request, draw)
      continue
    }
    flushVectors()
    const overlay = overlays.find((entry) => entry.key === layer.key)
    if (!overlay) continue
    const bytes = await loadImage(overlay)
    composites.push({ input: await reprojectRaster(bytes, overlay, request, projectionCache, signal) })
  }
  flushVectors()
  signal?.throwIfAborted()
  const canvas = sharp({ create: {
    width: request.width, height: request.height, channels: 4,
    background: request.transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : request.background,
  } })
  return (composites.length ? canvas.composite(composites) : canvas).png().toBuffer()
}
