import { estimateFootprintArea, footprintOutlineRings } from './firmsDetections.js'

export const RECENT_FIRE_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000
export const BURNED_AREA_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

function evidenceTimestampMs(evidence) {
  const explicitTimestampMs = evidence?.timestampMs
  if (explicitTimestampMs !== null && explicitTimestampMs !== ''
    && Number.isFinite(Number(explicitTimestampMs))) return Number(explicitTimestampMs)
  for (const key of ['acquiredAt', 'observedAt', 'latestObservedAt']) {
    const timestampMs = Date.parse(evidence?.[key])
    if (Number.isFinite(timestampMs)) return timestampMs
  }
  return null
}

function withinEvidenceWindow(evidence, frameTimestampMs, windowMs) {
  const timestampMs = evidenceTimestampMs(evidence)
  if (!Number.isFinite(timestampMs)) return false
  const ageMs = frameTimestampMs - timestampMs
  return ageMs >= 0 && ageMs < windowMs
}

function uniqueSupportCells(analyses) {
  const cells = new Map()
  analyses.forEach((analysis) => (analysis.supportCells ?? []).forEach((cell) => {
    if (!Array.isArray(cell) || cell.length !== 2) return
    const x = Number(cell[0])
    const y = Number(cell[1])
    if (!Number.isInteger(x) || !Number.isInteger(y)) return
    cells.set(`${x}:${y}`, [x, y])
  }))
  return [...cells.values()]
}

function supportPolygon(feature) {
  if (Array.isArray(feature)) return feature
  return feature?.polygon
}

function footprintState(detections, supportFeatures, supportCells, options) {
  const supportPolygons = supportFeatures.map(supportPolygon).filter((polygon) => (
    Array.isArray(polygon) && polygon.length >= 4
  ))
  return {
    detections,
    supportFeatures,
    supportPolygons,
    supportCells,
    area: estimateFootprintArea(detections, {
      ...options,
      supportPolygons,
      supportCells,
    }),
    rings: footprintOutlineRings(detections, {
      ...options,
      supportPolygons,
      supportCells,
    }),
  }
}

/**
 * Split one qualifying Best-estimate evidence union into two display states.
 *
 * Thermal detections and tightly filtered aircraft support can mark recent
 * activity for 24 hours. Sentinel-2 dNBR is burn-scar evidence rather than a
 * heat observation, so it is retained only in the black burned footprint. All
 * accepted evidence leaves the map after 30 days. These are explicit display
 * windows, not a measurement of extinguishment or vegetation regrowth.
 */
export function deriveFireActivityAreas({
  thermalDetections = [],
  sentinelAnalyses = [],
  aircraftSupportFeatures = [],
  frameTimestampMs,
  origin,
  gridCellM = 50,
  recentWindowMs = RECENT_FIRE_ACTIVITY_WINDOW_MS,
  retentionMs = BURNED_AREA_RETENTION_MS,
} = {}) {
  if (!Number.isFinite(Number(frameTimestampMs))) {
    throw new TypeError('frameTimestampMs must be a finite timestamp')
  }
  const selectedTimestampMs = Number(frameTimestampMs)
  const retainedThermal = thermalDetections.filter((evidence) => (
    withinEvidenceWindow(evidence, selectedTimestampMs, retentionMs)
  ))
  const recentThermal = retainedThermal.filter((evidence) => (
    withinEvidenceWindow(evidence, selectedTimestampMs, recentWindowMs)
  ))
  const retainedAircraft = aircraftSupportFeatures.filter((evidence) => (
    withinEvidenceWindow(evidence, selectedTimestampMs, retentionMs)
  ))
  const recentAircraft = retainedAircraft.filter((evidence) => (
    withinEvidenceWindow(evidence, selectedTimestampMs, recentWindowMs)
  ))
  const retainedSentinel = sentinelAnalyses.filter((evidence) => (
    withinEvidenceWindow(evidence, selectedTimestampMs, retentionMs)
  ))
  const options = { origin, gridCellM }

  return {
    burned: footprintState(
      retainedThermal,
      retainedAircraft,
      uniqueSupportCells(retainedSentinel),
      options,
    ),
    recent: footprintState(recentThermal, recentAircraft, [], options),
    recentWindowMs,
    retentionMs,
  }
}
