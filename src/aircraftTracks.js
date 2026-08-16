import {
  AIRCRAFT_PATH_MAX_GAP_MS,
  AIRCRAFT_PATH_MAX_SPEED_KT,
} from './data.js'

export const AIRCRAFT_TRACE_LIFETIME_MS = 24 * 60 * 60 * 1000
export const AIRCRAFT_TRACE_FADE_STEPS = 24

function haversineKm(left, right) {
  const radians = Math.PI / 180
  const deltaLat = (right.position[0] - left.position[0]) * radians
  const deltaLon = (right.position[1] - left.position[1]) * radians
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(left.position[0] * radians) * Math.cos(right.position[0] * radians) * Math.sin(deltaLon / 2) ** 2
  return 6371.0088 * 2 * Math.asin(Math.sqrt(value))
}

export function plausibleObservationPaths(
  observations,
  maxGapMs = AIRCRAFT_PATH_MAX_GAP_MS,
  maxSpeedKt = AIRCRAFT_PATH_MAX_SPEED_KT,
) {
  const paths = []
  let currentPath = []
  observations.slice(1).forEach((observation, index) => {
    const previous = observations[index]
    const elapsedMs = observation.timestampMs - previous.timestampMs
    if (elapsedMs <= 0 || elapsedMs > maxGapMs) {
      if (currentPath.length >= 2) paths.push(currentPath)
      currentPath = []
      return
    }
    const impliedSpeedKt = haversineKm(previous, observation) / 1.852 / (elapsedMs / 3_600_000)
    if (impliedSpeedKt > maxSpeedKt) {
      if (currentPath.length >= 2) paths.push(currentPath)
      currentPath = []
      return
    }
    if (!currentPath.length) currentPath.push(previous)
    currentPath.push(observation)
  })
  if (currentPath.length >= 2) paths.push(currentPath)
  return paths
}

export function aircraftTraceOpacity(
  timestampMs,
  frameTimestampMs,
  lifetimeMs = AIRCRAFT_TRACE_LIFETIME_MS,
) {
  const ageMs = frameTimestampMs - timestampMs
  if (!Number.isFinite(ageMs) || !Number.isFinite(lifetimeMs)
    || lifetimeMs <= 0 || ageMs < 0 || ageMs >= lifetimeMs) return 0
  return 1 - ageMs / lifetimeMs
}

export function visibleAircraftObservations(
  observations,
  frameTimestampMs,
  lifetimeMs = AIRCRAFT_TRACE_LIFETIME_MS,
) {
  return (observations || []).filter((observation) => (
    aircraftTraceOpacity(observation.timestampMs, frameTimestampMs, lifetimeMs) > 0
  ))
}

export function aircraftCoverageWindows(observations, maxGapMs = 5 * 60 * 1000) {
  const windows = []
  for (const observation of observations || []) {
    const previous = windows.at(-1)
    if (!previous || observation.timestampMs - previous.endMs > maxGapMs) {
      windows.push({ startMs: observation.timestampMs, endMs: observation.timestampMs })
    } else {
      previous.endMs = observation.timestampMs
    }
  }
  return windows
}

export function fadingObservationPaths(
  observations,
  frameTimestampMs,
  {
    lifetimeMs = AIRCRAFT_TRACE_LIFETIME_MS,
    fadeSteps = AIRCRAFT_TRACE_FADE_STEPS,
    maxGapMs = AIRCRAFT_PATH_MAX_GAP_MS,
    maxSpeedKt = AIRCRAFT_PATH_MAX_SPEED_KT,
  } = {},
) {
  const steps = Math.max(1, Math.floor(fadeSteps))
  const visible = visibleAircraftObservations(observations, frameTimestampMs, lifetimeMs)
  return plausibleObservationPaths(visible, maxGapMs, maxSpeedKt).flatMap((path) => {
    const fadedPaths = []
    let current = null
    for (let index = 1; index < path.length; index += 1) {
      const previous = path[index - 1]
      const observation = path[index]
      const midpointMs = (previous.timestampMs + observation.timestampMs) / 2
      const opacity = aircraftTraceOpacity(midpointMs, frameTimestampMs, lifetimeMs)
      if (opacity <= 0) continue
      const band = Math.min(steps - 1, Math.floor((1 - opacity) * steps))
      if (!current || current.band !== band) {
        current = { band, observations: [previous, observation], opacityTotal: opacity, segmentCount: 1 }
        fadedPaths.push(current)
      } else {
        current.observations.push(observation)
        current.opacityTotal += opacity
        current.segmentCount += 1
      }
    }
    return fadedPaths.map(({ observations: bandObservations, opacityTotal, segmentCount }) => ({
      observations: bandObservations,
      opacity: opacityTotal / segmentCount,
    }))
  })
}
