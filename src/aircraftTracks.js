import {
  AIRCRAFT_PATH_MAX_GAP_MS,
  AIRCRAFT_PATH_MAX_SPEED_KT,
} from './data.js'

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
