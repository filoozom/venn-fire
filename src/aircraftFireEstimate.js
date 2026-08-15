// Aircraft-supported fire-edge inference.
//
// ADS-B/MLAT positions say where an aircraft was, not whether it released water
// or where a fire perimeter was. The full GRZLY route is therefore never
// treated as fire geometry. This module retains only repeated, sharp direction
// changes near the corroborated FIRMS core: the fire-facing ends of repeated
// runs are useful contextual evidence, while long reservoir-side/transit legs are
// excluded.

export const AIRCRAFT_EDGE_GRID_CELL_M = 50
export const AIRCRAFT_EDGE_TIME_BUCKET_MS = 5 * 60 * 1000

const RESAMPLE_MS = 10 * 1000
const MIN_TURN_LOOKAROUND_MS = 15 * 1000
const MAX_TURN_LOOKAROUND_MS = 45 * 1000
const MIN_TURN_LEG_M = 100
const MIN_TURN_DEGREES = 70
const TURN_CLUSTER_GAP_MS = 75 * 1000
const MAX_CORE_DISTANCE_M = 3_500
const MIN_CORE_DISTANCE_M = AIRCRAFT_EDGE_GRID_CELL_M
const REPEAT_SUPPORT_RADIUS_M = 1_750
const MIN_REPEAT_SUPPORT = 2

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
    (position[1] - projection.longitude) * projection.metresPerLongitude,
    (position[0] - projection.latitude) * projection.metresPerLatitude,
  ]
}

function toLatLon(position, projection) {
  return [
    projection.latitude + position[1] / projection.metresPerLatitude,
    projection.longitude + position[0] / projection.metresPerLongitude,
  ]
}

function distance(left, right) {
  return Math.hypot(left[0] - right[0], left[1] - right[1])
}

function distanceToFireCoreM(position, detections, projection) {
  const [x, y] = toXY(position, projection)
  let closest = Number.POSITIVE_INFINITY
  detections.forEach((detection) => {
    const latitude = Number(detection.latitude)
    const longitude = Number(detection.longitude)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return
    const [centreX, centreY] = toXY([latitude, longitude], projection)
    const halfWidth = Math.max(0, Number(detection.scanKm) || 0) * 500
    const halfHeight = Math.max(0, Number(detection.trackKm) || 0) * 500
    const deltaX = Math.max(0, Math.abs(x - centreX) - halfWidth)
    const deltaY = Math.max(0, Math.abs(y - centreY) - halfHeight)
    closest = Math.min(closest, Math.hypot(deltaX, deltaY))
  })
  return closest
}

function normalizedObservations(flight, frameTimestampMs) {
  return (flight.observations ?? [])
    .map((observation) => {
      const timestampMs = Number.isFinite(observation.timestampMs)
        ? observation.timestampMs
        : Date.parse(observation.observedAt)
      const latitude = Number(observation.position?.[0])
      const longitude = Number(observation.position?.[1])
      if (!Number.isFinite(timestampMs) || timestampMs > frameTimestampMs
        || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
      return { ...observation, timestampMs, position: [latitude, longitude] }
    })
    .filter(Boolean)
    .sort((left, right) => left.timestampMs - right.timestampMs)
}

function resampleObservations(observations) {
  const bins = new Map()
  observations.forEach((observation) => {
    const key = Math.round(observation.timestampMs / RESAMPLE_MS) * RESAMPLE_MS
    const bin = bins.get(key) ?? []
    bin.push(observation)
    bins.set(key, bin)
  })
  return [...bins]
    .sort(([left], [right]) => left - right)
    .map(([, bin]) => ({
      timestampMs: Math.round(bin.reduce((sum, item) => sum + item.timestampMs, 0) / bin.length),
      position: [
        bin.reduce((sum, item) => sum + item.position[0], 0) / bin.length,
        bin.reduce((sum, item) => sum + item.position[1], 0) / bin.length,
      ],
      altitudeFt: (() => {
        const values = bin.map((item) => Number(item.altitudeFt)).filter(Number.isFinite)
        return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null
      })(),
    }))
}

function surroundingSample(samples, index, direction) {
  const centre = samples[index]
  for (let cursor = index + direction; cursor >= 0 && cursor < samples.length; cursor += direction) {
    const elapsed = Math.abs(samples[cursor].timestampMs - centre.timestampMs)
    if (elapsed > MAX_TURN_LOOKAROUND_MS) return null
    if (elapsed >= MIN_TURN_LOOKAROUND_MS) return samples[cursor]
  }
  return null
}

function turnDegrees(previous, current, next, projection) {
  const before = toXY(previous.position, projection)
  const centre = toXY(current.position, projection)
  const after = toXY(next.position, projection)
  const incoming = [centre[0] - before[0], centre[1] - before[1]]
  const outgoing = [after[0] - centre[0], after[1] - centre[1]]
  const incomingLength = Math.hypot(...incoming)
  const outgoingLength = Math.hypot(...outgoing)
  if (incomingLength < MIN_TURN_LEG_M || outgoingLength < MIN_TURN_LEG_M) return 0
  const cosine = Math.max(-1, Math.min(1,
    (incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) / (incomingLength * outgoingLength),
  ))
  return Math.acos(cosine) * 180 / Math.PI
}

function clusterTurns(turns) {
  const clusters = []
  turns.forEach((turn) => {
    const current = clusters.at(-1)
    if (!current || turn.timestampMs - current.at(-1).timestampMs > TURN_CLUSTER_GAP_MS) {
      clusters.push([turn])
    } else {
      current.push(turn)
    }
  })
  return clusters.map((cluster) => cluster.reduce((best, turn) => (
    turn.turnDegrees > best.turnDegrees ? turn : best
  )))
}

function candidateTurns(flight, detections, projection, frameTimestampMs, timeBucketMs) {
  const samples = resampleObservations(normalizedObservations(flight, frameTimestampMs))
  const turns = samples.flatMap((sample, index) => {
    const previous = surroundingSample(samples, index, -1)
    const next = surroundingSample(samples, index, 1)
    if (!previous || !next) return []
    const degrees = turnDegrees(previous, sample, next, projection)
    if (degrees < MIN_TURN_DEGREES) return []
    const coreDistanceM = distanceToFireCoreM(sample.position, detections, projection)
    if (coreDistanceM < MIN_CORE_DISTANCE_M || coreDistanceM > MAX_CORE_DISTANCE_M) return []
    return [{
      ...sample,
      callSign: flight.callSign,
      icao24: flight.icao24,
      turnDegrees: degrees,
      coreDistanceM,
    }]
  })

  // A five-minute viewer frame should contribute at most one fire-edge point per
  // aircraft. The point becomes available at the next frame boundary, matching
  // the way exact FIRMS acquisition times enter the timeline.
  const byFrame = new Map()
  clusterTurns(turns).forEach((turn) => {
    const frameAtMs = Math.ceil(turn.timestampMs / timeBucketMs) * timeBucketMs
    const key = `${flight.icao24 ?? flight.callSign}:${frameAtMs}`
    const previous = byFrame.get(key)
    if (!previous || turn.turnDegrees > previous.turnDegrees) {
      byFrame.set(key, { ...turn, frameAtMs })
    }
  })
  return [...byFrame.values()]
}

function snapToGrid(position, projection, gridCellM) {
  const [x, y] = toXY(position, projection)
  return toLatLon([
    (Math.floor(x / gridCellM) + 0.5) * gridCellM,
    (Math.floor(y / gridCellM) + 0.5) * gridCellM,
  ], projection)
}

function spatialOrder(candidates, projection) {
  if (candidates.length < 2) return candidates
  const points = candidates.map((candidate) => toXY(candidate.position, projection))
  const centre = [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
  ]
  const covariance = points.reduce((value, point) => {
    const x = point[0] - centre[0]
    const y = point[1] - centre[1]
    return {
      xx: value.xx + x * x,
      xy: value.xy + x * y,
      yy: value.yy + y * y,
    }
  }, { xx: 0, xy: 0, yy: 0 })
  const angle = 0.5 * Math.atan2(2 * covariance.xy, covariance.xx - covariance.yy)
  const axis = [Math.cos(angle), Math.sin(angle)]
  return candidates.slice().sort((left, right) => {
    const leftPoint = toXY(left.position, projection)
    const rightPoint = toXY(right.position, projection)
    return (leftPoint[0] - centre[0]) * axis[0] + (leftPoint[1] - centre[1]) * axis[1]
      - ((rightPoint[0] - centre[0]) * axis[0] + (rightPoint[1] - centre[1]) * axis[1])
  })
}

function closestOutlinePoint(position, rings, projection) {
  const target = toXY(position, projection)
  let closest = null
  let closestDistance = Number.POSITIVE_INFINITY
  rings.forEach((ring) => ring.slice(0, -1).forEach((point) => {
    const pointDistance = distance(target, toXY(point, projection))
    if (pointDistance < closestDistance) {
      closest = point
      closestDistance = pointDistance
    }
  }))
  return closest
}

/**
 * Derive a visually separate extension to the satellite-only best estimate.
 *
 * The result deliberately has no area field: a receiver track has no payload or
 * drop-state information and cannot support a burned-hectare calculation.
 */
export function deriveAircraftSupportedEdge({
  flights = [],
  detections = [],
  outlineRings = [],
  frameTimestampMs = Number.POSITIVE_INFINITY,
  origin,
  gridCellM = AIRCRAFT_EDGE_GRID_CELL_M,
  timeBucketMs = AIRCRAFT_EDGE_TIME_BUCKET_MS,
} = {}) {
  const projection = projectionFor(origin)
  if (!projection || !detections.length || !outlineRings.length) {
    return { candidates: [], extensionLine: [], callSigns: [], gridCellM, timeBucketMs }
  }

  const candidates = flights
    .filter((flight) => /^GRZLY\d{1,3}$/iu.test(flight.callSign ?? ''))
    .flatMap((flight) => candidateTurns(
      flight,
      detections,
      projection,
      frameTimestampMs,
      timeBucketMs,
    ))

  // One isolated manoeuvre can be unrelated. Keep only locations supported by
  // another qualifying five-minute frame nearby, which is what distinguishes a
  // repeated pattern from a single transit turn.
  const supported = candidates
    .map((candidate) => ({
      ...candidate,
      supportCount: candidates.filter((other) => (
        other.frameAtMs !== candidate.frameAtMs
        && distance(toXY(other.position, projection), toXY(candidate.position, projection)) <= REPEAT_SUPPORT_RADIUS_M
      )).length + 1,
    }))
    .filter((candidate) => candidate.supportCount >= MIN_REPEAT_SUPPORT)
    .map((candidate) => ({
      ...candidate,
      position: snapToGrid(candidate.position, projection, gridCellM),
      observedAt: new Date(candidate.timestampMs).toISOString(),
    }))

  if (supported.length < MIN_REPEAT_SUPPORT) {
    return { candidates: [], extensionLine: [], callSigns: [], gridCellM, timeBucketMs }
  }

  const ordered = spatialOrder(supported, projection)
  const startAnchor = closestOutlinePoint(ordered[0].position, outlineRings, projection)
  const endAnchor = closestOutlinePoint(ordered.at(-1).position, outlineRings, projection)
  const extensionLine = [startAnchor, ...ordered.map((candidate) => candidate.position), endAnchor]
    .filter(Boolean)
    .filter((position, index, all) => (
      index === 0 || position[0] !== all[index - 1][0] || position[1] !== all[index - 1][1]
    ))

  return {
    candidates: supported.slice().sort((left, right) => left.timestampMs - right.timestampMs),
    extensionLine,
    callSigns: [...new Set(supported.map((candidate) => candidate.callSign))].sort(),
    latestObservedAt: new Date(Math.max(...supported.map((candidate) => candidate.timestampMs))).toISOString(),
    gridCellM,
    timeBucketMs,
  }
}
