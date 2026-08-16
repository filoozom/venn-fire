#!/usr/bin/env node

import assert from 'node:assert/strict'

import { plausibleObservationPaths } from '../src/aircraftTracks.js'

function fix(seconds, latitude, longitude) {
  const timestampMs = Date.parse('2026-08-15T12:00:00.000Z') + seconds * 1_000
  return {
    observedAt: new Date(timestampMs).toISOString(),
    timestampMs,
    position: [latitude, longitude],
  }
}

const first = fix(0, 50.55, 6.06)
const second = fix(30, 50.5502, 6.0602)
const afterGap = fix(300, 50.551, 6.061)
const afterGapSecond = fix(330, 50.5512, 6.0612)
const impossibleJump = fix(340, 51.5, 7.5)

const paths = plausibleObservationPaths([
  first,
  second,
  afterGap,
  afterGapSecond,
  impossibleJump,
])

assert.equal(paths.length, 2)
assert.deepEqual(paths[0], [first, second])
assert.deepEqual(paths[1], [afterGap, afterGapSecond])
assert.equal(plausibleObservationPaths([first]).length, 0)

console.log('Verified: exact aircraft fixes are grouped into efficient paths without bridging gaps.')
