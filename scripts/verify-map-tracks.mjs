#!/usr/bin/env node

import assert from 'node:assert/strict'

import {
  AIRCRAFT_TRACE_LIFETIME_MS,
  aircraftCoverageWindows,
  aircraftTraceOpacity,
  fadingObservationPaths,
  plausibleObservationPaths,
  visibleAircraftObservations,
} from '../src/aircraftTracks.js'

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

const frameTimestampMs = first.timestampMs + 12 * 60 * 60 * 1000
assert.equal(aircraftTraceOpacity(first.timestampMs, first.timestampMs), 1)
assert.equal(aircraftTraceOpacity(first.timestampMs, frameTimestampMs), 0.5)
assert.equal(aircraftTraceOpacity(first.timestampMs, first.timestampMs + AIRCRAFT_TRACE_LIFETIME_MS), 0)
assert.equal(aircraftTraceOpacity(first.timestampMs, first.timestampMs - 1), 0)
assert.deepEqual(visibleAircraftObservations([first, second], frameTimestampMs), [first, second])
assert.equal(visibleAircraftObservations([first], first.timestampMs + AIRCRAFT_TRACE_LIFETIME_MS).length, 0)

const fading = fadingObservationPaths([first, second], frameTimestampMs)
assert.equal(fading.length, 1)
assert.deepEqual(fading[0].observations, [first, second])
assert.ok(fading[0].opacity > 0.49 && fading[0].opacity < 0.51)
assert.equal(fadingObservationPaths([first, second], first.timestampMs + AIRCRAFT_TRACE_LIFETIME_MS).length, 0)
assert.equal(aircraftCoverageWindows([first, second, afterGap, afterGapSecond]).length, 1)

console.log('Verified: exact aircraft fixes use efficient gap-limited paths and a linear 24-hour display fade.')
