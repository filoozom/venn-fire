import assert from 'node:assert/strict'

import {
  dissolveGridCellsToMultiPolygon,
  selectSentinelSupportCells,
  SENTINEL_ANALYSIS_GRID_M,
  SENTINEL_DNBR_ANCHOR_THRESHOLD,
  SENTINEL_DNBR_THRESHOLD,
} from '../server/sentinel-analysis.mjs'
import { estimateFootprintArea, footprintOutlineRings } from '../src/firmsDetections.js'

const acceptedStats = new Map([
  ['0:0', { count: 2, maxDnbr: 0.24 }],
  ['1:0', { count: 3, maxDnbr: 0.28 }],
  ['2:0', { count: 2, maxDnbr: 0.21 }],
  ['3:0', { count: 4, maxDnbr: 0.33 }],
  // Too few pixels.
  ['4:0', { count: 1, maxDnbr: 0.50 }],
  // Four connected cells, but none has the required strong anchor value.
  ['10:0', { count: 3, maxDnbr: 0.19 }],
  ['11:0', { count: 3, maxDnbr: 0.19 }],
  ['12:0', { count: 3, maxDnbr: 0.19 }],
  ['13:0', { count: 3, maxDnbr: 0.19 }],
  // Strong but only a three-cell speckle component.
  ['20:0', { count: 2, maxDnbr: 0.30 }],
  ['21:0', { count: 2, maxDnbr: 0.30 }],
  ['22:0', { count: 2, maxDnbr: 0.30 }],
])

const selected = selectSentinelSupportCells(acceptedStats)
assert.deepEqual(selected, [[0, 0], [1, 0], [2, 0], [3, 0]])
assert.equal(SENTINEL_DNBR_THRESHOLD, 0.15)
assert.equal(SENTINEL_DNBR_ANCHOR_THRESHOLD, 0.20)
assert.equal(SENTINEL_ANALYSIS_GRID_M, 50)

// The raster dissolver must preserve the unoccupied middle cell as a hole; a
// visual overlay that filled it would claim change where no pixel qualified.
const ringCells = []
for (let y = 0; y < 3; y += 1) {
  for (let x = 0; x < 3; x += 1) {
    if (x !== 1 || y !== 1) ringCells.push([x, y])
  }
}
const geometry = dissolveGridCellsToMultiPolygon(ringCells)
assert.equal(geometry.type, 'MultiPolygon')
assert.equal(geometry.coordinates.length, 1)
assert.equal(geometry.coordinates[0].length, 2)
for (const ring of geometry.coordinates[0]) assert.deepEqual(ring[0], ring.at(-1))

const detection = {
  latitude: 50.54762,
  longitude: 6.05757,
  scanKm: 0.05,
  trackKm: 0.05,
}
const baseline = estimateFootprintArea([detection], {
  gridCellM: 50,
  origin: { latitude: 50.54762, longitude: 6.05757 },
})
const withSentinel = estimateFootprintArea([detection], {
  gridCellM: 50,
  origin: { latitude: 50.54762, longitude: 6.05757 },
  supportCells: [[0, 0], [1, 0], [2, 0], [3, 0]],
})
assert.equal(baseline.unionHa, 0.25)
assert.equal(withSentinel.directSupportCellCount, 4)
assert.equal(withSentinel.directSupportAreaHa, 1)
assert.equal(withSentinel.unionHa, 1.25)
assert.ok(footprintOutlineRings([detection], {
  gridCellM: 50,
  origin: { latitude: 50.54762, longitude: 6.05757 },
  supportCells: [[0, 0], [1, 0], [2, 0], [3, 0]],
}).length > 0)

console.log(JSON.stringify({
  selectedCells: selected.length,
  holePreserved: geometry.coordinates[0].length === 2,
  directSupportAreaHa: withSentinel.directSupportAreaHa,
}, null, 2))
