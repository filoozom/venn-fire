#!/usr/bin/env node

import assert from 'node:assert/strict'
import {
  AIRCRAFT_EDGE_GRID_CELL_M,
  AIRCRAFT_EDGE_TIME_BUCKET_MS,
  deriveAircraftSupportedEdge,
} from '../src/aircraftFireEstimate.js'
import { footprintOutlineRings } from '../src/firmsDetections.js'

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
  const xValues = [600, 900, 1_200, 1_500, turnX, 1_500, 1_200, 900, 600]
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
    ...reversal(60_000, 1_650, 0),
    ...reversal(6 * 60_000, 1_700, 300),
    // A repeated turn far from the thermal core represents a reservoir-side
    // route manoeuvre. It must not become fire-edge evidence.
    ...reversal(12 * 60_000, 6_000, 4_000),
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
  flights: [incidentFlight, unrelatedFlight],
  detections: [detection],
  outlineRings,
  frameTimestampMs: startMs + 20 * 60_000,
  origin,
})

assert.equal(edge.candidates.length, 2, 'two repeated near-core GRZLY turns should support the edge')
assert.deepEqual(edge.callSigns, ['GRZLY81'], 'unrelated callsigns must be excluded')
assert.equal(edge.extensionLine.length, 4, 'the two evidence cells should connect to two core anchors')
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

const beforeRepeat = deriveAircraftSupportedEdge({
  flights: [incidentFlight],
  detections: [detection],
  outlineRings,
  frameTimestampMs: startMs + 4 * 60_000,
  origin,
})
assert.equal(beforeRepeat.candidates.length, 0, 'one isolated manoeuvre must not be promoted retroactively')

const noCore = deriveAircraftSupportedEdge({ flights: [incidentFlight], origin })
assert.deepEqual(noCore.extensionLine, [], 'aircraft positions cannot create a fire outline without a satellite core')

console.log('Aircraft-supported fire-edge checks passed')
