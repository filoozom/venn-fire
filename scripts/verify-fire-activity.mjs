#!/usr/bin/env node

import assert from 'node:assert/strict'

import {
  BURNED_AREA_RETENTION_MS,
  RECENT_FIRE_ACTIVITY_WINDOW_MS,
  deriveFireActivityAreas,
} from '../src/fireActivityEstimate.js'

const origin = { latitude: 50.54, longitude: 6.08 }
const frameTimestampMs = Date.parse('2026-09-01T12:00:00.000Z')
const phi = origin.latitude * Math.PI / 180
const metresPerLongitude = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi)
const positionAtX = (x) => ({
  latitude: origin.latitude,
  longitude: origin.longitude + x / metresPerLongitude,
})
const detection = (x, ageMs) => ({
  ...positionAtX(x),
  scanKm: 0.1,
  trackKm: 0.1,
  timestampMs: frameTimestampMs - ageMs,
  acquiredAt: new Date(frameTimestampMs - ageMs).toISOString(),
})
const polygon = (x, ageMs) => ({
  timestampMs: frameTimestampMs - ageMs,
  observedAt: new Date(frameTimestampMs - ageMs).toISOString(),
  polygon: [
    [origin.latitude, origin.longitude + x / metresPerLongitude],
    [origin.latitude, origin.longitude + (x + 100) / metresPerLongitude],
    [origin.latitude + 100 / 111_132, origin.longitude + (x + 100) / metresPerLongitude],
    [origin.latitude + 100 / 111_132, origin.longitude + x / metresPerLongitude],
    [origin.latitude, origin.longitude + x / metresPerLongitude],
  ],
})

const state = deriveFireActivityAreas({
  thermalDetections: [
    detection(0, 60 * 60 * 1000),
    detection(500, 2 * 24 * 60 * 60 * 1000),
    detection(1_000, 31 * 24 * 60 * 60 * 1000),
  ],
  sentinelAnalyses: [{
    acquiredAt: new Date(frameTimestampMs - 3 * 24 * 60 * 60 * 1000).toISOString(),
    supportCells: [[30, 0]],
  }],
  aircraftSupportFeatures: [
    polygon(2_000, 2 * 60 * 60 * 1000),
    polygon(2_500, 4 * 24 * 60 * 60 * 1000),
  ],
  frameTimestampMs,
  origin,
  gridCellM: 50,
})

assert.equal(state.burned.detections.length, 2, '30-day footprint should exclude expired thermal evidence')
assert.equal(state.recent.detections.length, 1, 'red should contain only thermal evidence newer than 24 hours')
assert.equal(state.burned.supportFeatures.length, 2, 'aircraft-supported burn cells should remain black for 30 days')
assert.equal(state.recent.supportFeatures.length, 1, 'only recent aircraft support should remain red')
assert.deepEqual(state.burned.supportCells, [[30, 0]], 'Sentinel-2 burn change should support the black footprint')
assert.deepEqual(state.recent.supportCells, [], 'Sentinel-2 burn change must never claim live heat')
assert.ok(state.burned.area.unionHa > state.recent.area.unionHa)
assert.ok(state.burned.rings.length > 0)
assert.ok(state.recent.rings.length > 0)

const cutoff = deriveFireActivityAreas({
  thermalDetections: [
    detection(0, RECENT_FIRE_ACTIVITY_WINDOW_MS),
    detection(500, BURNED_AREA_RETENTION_MS),
  ],
  frameTimestampMs,
  origin,
})
assert.equal(cutoff.recent.detections.length, 0, 'evidence stops being red exactly at 24 hours')
assert.equal(cutoff.burned.detections.length, 1, 'evidence stops being retained exactly at 30 days')

const sentinelOnly = deriveFireActivityAreas({
  sentinelAnalyses: [{
    timestampMs: null,
    acquiredAt: new Date(frameTimestampMs - 60_000).toISOString(),
    supportCells: [[0, 0]],
  }],
  frameTimestampMs,
  origin,
})
assert.equal(sentinelOnly.burned.area.unionHa, 0.25, 'support-only burned geometry should use the shared 50 m grid')
assert.equal(sentinelOnly.recent.area.unionHa, 0, 'a fresh burn-scar image is still not active heat')
assert.ok(sentinelOnly.burned.rings.length > 0)

console.log(JSON.stringify({
  burnedAreaHa: state.burned.area.unionHa,
  recentAreaHa: state.recent.area.unionHa,
  retentionDays: BURNED_AREA_RETENTION_MS / 86_400_000,
  recentHours: RECENT_FIRE_ACTIVITY_WINDOW_MS / 3_600_000,
}, null, 2))
