// MODIS-supported fire-extent inference.
//
// A FIRMS MODIS detection says that one or more thermal anomalies occurred
// somewhere inside a nominal 1 km pixel. It does not locate the flame within
// that pixel and it is not a burned-area observation. MODIS can nevertheless
// add useful, visibly coarse support around the higher-resolution VIIRS core.
//
// To avoid turning successive 1 km snapshots into an ever-growing false burn
// scar, this module uses only the newest overpass available at the selected
// five-minute frame. It also requires every included pixel to remain close to
// independently supported incident geometry.

import { footprintOutlineRings } from './firmsDetections.js'

export const MODIS_EXTENT_GRID_CELL_M = 50
export const MODIS_EXTENT_TIME_BUCKET_MS = 5 * 60 * 1000
export const MODIS_MAX_SUPPORT_GAP_M = 500
export const MODIS_EXTENT_RULE = 'newest high-confidence Terra/Aqua pass within 500 m of the VIIRS core or aircraft-supported edge'

function projectionFor(origin) {
  const latitude = Number(origin?.latitude ?? origin?.[0])
  const longitude = Number(origin?.longitude ?? origin?.[1])
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  const phi = (latitude * Math.PI) / 180
  return {
    latitude,
    longitude,
    metresPerLatitude: 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi),
    metresPerLongitude: 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi),
  }
}

function toXY(position, projection) {
  return [
    (Number(position[1]) - projection.longitude) * projection.metresPerLongitude,
    (Number(position[0]) - projection.latitude) * projection.metresPerLatitude,
  ]
}

function validDetection(detection) {
  return Number.isFinite(Number(detection?.latitude))
    && Number.isFinite(Number(detection?.longitude))
    && Number(detection?.scanKm) > 0
    && Number(detection?.trackKm) > 0
}

function rectangleDistanceM(left, right, projection) {
  const [leftX, leftY] = toXY([left.latitude, left.longitude], projection)
  const [rightX, rightY] = toXY([right.latitude, right.longitude], projection)
  const halfWidth = (Number(left.scanKm) + Number(right.scanKm)) * 500
  const halfHeight = (Number(left.trackKm) + Number(right.trackKm)) * 500
  const deltaX = Math.max(0, Math.abs(leftX - rightX) - halfWidth)
  const deltaY = Math.max(0, Math.abs(leftY - rightY) - halfHeight)
  return Math.hypot(deltaX, deltaY)
}

function rectangleToCellDistanceM(detection, candidate, projection, gridCellM) {
  const position = candidate?.position
  if (!Array.isArray(position) || position.length < 2) return Number.POSITIVE_INFINITY
  const [pixelX, pixelY] = toXY([detection.latitude, detection.longitude], projection)
  const [cellX, cellY] = toXY(position, projection)
  const halfCell = gridCellM / 2
  const deltaX = Math.max(0, Math.abs(pixelX - cellX) - Number(detection.scanKm) * 500 - halfCell)
  const deltaY = Math.max(0, Math.abs(pixelY - cellY) - Number(detection.trackKm) * 500 - halfCell)
  return Math.hypot(deltaX, deltaY)
}

function emptyExtent(gridCellM, timeBucketMs, maxSupportGapM) {
  return {
    detections: [],
    outlineRings: [],
    satellites: [],
    passAcquiredAt: null,
    availableAt: null,
    sourceDetectionCount: 0,
    highConfidenceDetectionCount: 0,
    gridCellM,
    timeBucketMs,
    maxSupportGapM,
  }
}

/**
 * Derive the coarse MODIS component of the Best estimate outline.
 *
 * The result intentionally has no area field. Rasterising a 1 km active-fire
 * pixel on the shared 50 m display grid makes its uncertainty legible; it does
 * not make the source observation 50 m precise.
 */
export function deriveModisSupportedExtent({
  detections = [],
  coreDetections = [],
  aircraftEdgeCandidates = [],
  frameTimestampMs = Number.POSITIVE_INFINITY,
  origin,
  gridCellM = MODIS_EXTENT_GRID_CELL_M,
  timeBucketMs = MODIS_EXTENT_TIME_BUCKET_MS,
  maxSupportGapM = MODIS_MAX_SUPPORT_GAP_M,
} = {}) {
  const projection = projectionFor(origin)
  const empty = emptyExtent(gridCellM, timeBucketMs, maxSupportGapM)
  const validCore = coreDetections.filter(validDetection)
  if (!projection || !validCore.length
    || !Number.isFinite(Number(gridCellM)) || gridCellM <= 0
    || !Number.isFinite(Number(timeBucketMs)) || timeBucketMs <= 0
    || !Number.isFinite(Number(maxSupportGapM)) || maxSupportGapM < 0) return empty

  const available = detections
    .filter((detection) => (
      detection?.sensorKey === 'modis'
      && validDetection(detection)
    ))
    .map((detection) => {
      const timestampMs = Number.isFinite(detection.timestampMs)
        ? detection.timestampMs
        : Date.parse(detection.acquiredAt)
      const frameAtMs = Math.ceil(timestampMs / timeBucketMs) * timeBucketMs
      return Number.isFinite(timestampMs) && frameAtMs <= frameTimestampMs
        ? { detection, timestampMs, frameAtMs }
        : null
    })
    .filter(Boolean)

  if (!available.length) return empty
  const latestFrameAtMs = Math.max(...available.map((entry) => entry.frameAtMs))
  const latestPass = available.filter((entry) => entry.frameAtMs === latestFrameAtMs)
  const highConfidencePass = latestPass.filter(({ detection }) => detection?.confidence?.label === 'high')
  const supported = highConfidencePass.filter(({ detection }) => {
    const coreDistanceM = Math.min(...validCore.map((core) => rectangleDistanceM(detection, core, projection)))
    const aircraftDistanceM = aircraftEdgeCandidates.length
      ? Math.min(...aircraftEdgeCandidates.map((candidate) => (
          rectangleToCellDistanceM(detection, candidate, projection, gridCellM)
        )))
      : Number.POSITIVE_INFINITY
    return coreDistanceM <= maxSupportGapM || aircraftDistanceM <= maxSupportGapM
  })

  if (!supported.length) {
    return {
      ...empty,
      passAcquiredAt: new Date(Math.max(...latestPass.map((entry) => entry.timestampMs))).toISOString(),
      availableAt: new Date(latestFrameAtMs).toISOString(),
      sourceDetectionCount: latestPass.length,
      highConfidenceDetectionCount: highConfidencePass.length,
    }
  }

  const supportedDetections = supported.map((entry) => entry.detection)
  return {
    detections: supportedDetections,
    outlineRings: footprintOutlineRings(supportedDetections, { origin, gridCellM }),
    satellites: [...new Set(supportedDetections.map((detection) => detection.satellite).filter(Boolean))].sort(),
    passAcquiredAt: new Date(Math.max(...supported.map((entry) => entry.timestampMs))).toISOString(),
    availableAt: new Date(latestFrameAtMs).toISOString(),
    sourceDetectionCount: latestPass.length,
    highConfidenceDetectionCount: highConfidencePass.length,
    gridCellM,
    timeBucketMs,
    maxSupportGapM,
  }
}
