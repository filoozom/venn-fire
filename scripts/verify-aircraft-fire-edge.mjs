#!/usr/bin/env node

import assert from 'node:assert/strict'
import {
  AIRCRAFT_EDGE_GRID_CELL_M,
  AIRCRAFT_EDGE_TIME_BUCKET_MS,
  deriveAircraftSupportedEdge,
} from '../src/aircraftFireEstimate.js'
import { AIRCRAFT_TRACE_LIFETIME_MS, visibleAircraftObservations } from '../src/aircraftTracks.js'
import { estimateFootprintArea, footprintOutlineRings } from '../src/firmsDetections.js'

const origin = { latitude: 50.54, longitude: 6.08 }
const phi = origin.latitude * Math.PI / 180
const metresPerLatitude = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi)
const metresPerLongitude = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi)
const positionAt = (x, y) => [
  origin.latitude + y / metresPerLatitude,
  origin.longitude + x / metresPerLongitude,
]

const detection = {
  latitude: origin.latitude,
  longitude: origin.longitude,
  scanKm: 0.375,
  trackKm: 0.375,
}
const outlineRings = footprintOutlineRings([detection], { origin, gridCellM: AIRCRAFT_EDGE_GRID_CELL_M })
const startMs = Date.parse('2026-08-15T10:00:00.000Z')

function reversal(startOffsetMs, turnX, y) {
  const direction = Math.sign(turnX) || 1
  const xValues = [200, 350, 500, 650, Math.abs(turnX), 650, 500, 350, 200]
    .map((x) => x * direction)
  return xValues.map((x, index) => ({
    timestampMs: startMs + startOffsetMs + index * 10_000,
    observedAt: new Date(startMs + startOffsetMs + index * 10_000).toISOString(),
    position: positionAt(x, y),
    altitudeFt: 2_200,
  }))
}

const incidentFlight = {
  icao24: '480849',
  callSign: 'GRZLY81',
  observations: [
    ...reversal(60_000, 850, 0),
    ...reversal(6 * 60_000, 900, 300),
    // A repeated turn far from the thermal core represents a reservoir-side
    // route manoeuvre. It must not become fire-edge evidence.
    ...reversal(12 * 60_000, 6_000, 4_000),
  ],
}

const approachOutliers = {
  icao24: '480440',
  callSign: 'GRZLY80',
  observations: [
    // This compact repeated pair would have passed the former 3.5 km core
    // allowance and produced an approach corridor. It must now be excluded.
    ...reversal(2 * 60_000, 2_500, 2_200),
    ...reversal(8 * 60_000, 2_600, 2_300),
  ],
}

const unrelatedFlight = {
  icao24: 'abcdef',
  callSign: 'TEST01',
  observations: [
    ...reversal(2 * 60_000, 1_600, 100),
    ...reversal(8 * 60_000, 1_650, 200),
  ],
}

const edge = deriveAircraftSupportedEdge({
  flights: [incidentFlight, approachOutliers, unrelatedFlight],
  detections: [detection],
  outlineRings,
  frameTimestampMs: startMs + 20 * 60_000,
  origin,
})

assert.equal(edge.candidates.length, 2, 'two repeated near-core GRZLY turns should support the edge')
assert.deepEqual(edge.callSigns, ['GRZLY81'], 'unrelated callsigns must be excluded')
assert.equal(edge.extensionLines.length, 1, 'one local evidence cluster should produce one compact extension')
assert.equal(edge.extensionLines[0].length, 4, 'the two evidence cells should connect to two core anchors')
assert.equal(edge.supportPolygons.length, 1, 'one local evidence cluster should produce one compact lobe')
assert.ok(edge.supportPolygons[0].length >= 4, 'supported turns should close conservatively against the existing outline')
assert.equal('areaHa' in edge, false, 'aircraft evidence must never generate a hectare figure')
edge.candidates.forEach((candidate) => {
  assert.equal(candidate.frameAtMs % AIRCRAFT_EDGE_TIME_BUCKET_MS, 0, 'evidence should enter on a five-minute boundary')
  const x = (candidate.position[1] - origin.longitude) * metresPerLongitude
  const y = (candidate.position[0] - origin.latitude) * metresPerLatitude
  assert.ok(Math.abs(x / AIRCRAFT_EDGE_GRID_CELL_M - 0.5 - Math.round(x / AIRCRAFT_EDGE_GRID_CELL_M - 0.5)) < 1e-8,
    'longitude should snap to the shared 50 m grid')
  assert.ok(Math.abs(y / AIRCRAFT_EDGE_GRID_CELL_M - 0.5 - Math.round(y / AIRCRAFT_EDGE_GRID_CELL_M - 0.5)) < 1e-8,
    'latitude should snap to the shared 50 m grid')
})

const coreOnlyArea = estimateFootprintArea([detection], {
  origin,
  gridCellM: AIRCRAFT_EDGE_GRID_CELL_M,
})
const combinedArea = estimateFootprintArea([detection], {
  origin,
  gridCellM: AIRCRAFT_EDGE_GRID_CELL_M,
  supportPolygons: edge.supportPolygons,
})
const combinedOutline = footprintOutlineRings([detection], {
  origin,
  gridCellM: AIRCRAFT_EDGE_GRID_CELL_M,
  supportPolygons: edge.supportPolygons,
})
assert.ok(combinedArea.supportCellCount > 0, 'the supported lobe should add occupied 50 m cells')
assert.ok(combinedArea.unionHa > coreOnlyArea.unionHa, 'the area must describe the same extended union as the outline')
assert.notDeepEqual(combinedOutline, outlineRings, 'the supported lobe should alter the one dissolved outline')

const secondFront = {
  icao24: '48044c',
  callSign: 'GRZLY80',
  observations: [
    ...reversal(2 * 60_000, -850, 0),
    ...reversal(8 * 60_000, -900, 300),
  ],
}
const separatedEdge = deriveAircraftSupportedEdge({
  flights: [incidentFlight, secondFront],
  detections: [detection],
  outlineRings,
  frameTimestampMs: startMs + 10 * 60_000,
  origin,
})
assert.equal(separatedEdge.supportPolygons.length, 2,
  'disconnected repeated turn clusters must remain separate compact lobes')
separatedEdge.supportPolygons.forEach((polygon) => {
  const coordinates = polygon.map((position) => [
    (position[1] - origin.longitude) * metresPerLongitude,
    (position[0] - origin.latitude) * metresPerLatitude,
  ])
  const xs = coordinates.map(([x]) => x)
  const ys = coordinates.map(([, y]) => y)
  assert.ok(Math.max(...xs) - Math.min(...xs) <= 1_500
    && Math.max(...ys) - Math.min(...ys) <= 1_500,
  'each supported lobe should remain spatially compact')
})

const beforeRepeat = deriveAircraftSupportedEdge({
  flights: [incidentFlight],
  detections: [detection],
  outlineRings,
  frameTimestampMs: startMs + 4 * 60_000,
  origin,
})
assert.equal(beforeRepeat.candidates.length, 0, 'one isolated manoeuvre must not be promoted retroactively')

const afterDisplayExpiryMs = startMs + AIRCRAFT_TRACE_LIFETIME_MS + 20 * 60_000
const currentAfterExpiry = deriveAircraftSupportedEdge({
  flights: [{
    ...incidentFlight,
    observations: visibleAircraftObservations(incidentFlight.observations, afterDisplayExpiryMs),
  }],
  detections: [detection],
  outlineRings,
  frameTimestampMs: afterDisplayExpiryMs,
  origin,
})
const touchedAfterExpiry = deriveAircraftSupportedEdge({
  flights: [incidentFlight],
  detections: [detection],
  outlineRings,
  frameTimestampMs: afterDisplayExpiryMs,
  origin,
})
assert.equal(currentAfterExpiry.supportPolygons.length, 0,
  'aged aircraft evidence must leave the current solid estimate')
assert.equal(touchedAfterExpiry.supportPolygons.length, 1,
  'strictly qualified aged evidence must remain available to the touched zone')

const noCore = deriveAircraftSupportedEdge({ flights: [incidentFlight], origin })
assert.deepEqual(noCore.extensionLines, [], 'aircraft positions cannot create a fire outline without a satellite core')
assert.deepEqual(noCore.supportPolygons, [], 'aircraft positions cannot create support geometry without a satellite core')

console.log('Aircraft-supported fire-edge checks passed')
