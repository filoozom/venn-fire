#!/usr/bin/env node

import assert from 'node:assert/strict'

import {
  MODIS_EXTENT_GRID_CELL_M,
  MODIS_EXTENT_TIME_BUCKET_MS,
  deriveModisSupportedExtent,
} from '../src/modisFireEstimate.js'
import { estimateFootprintArea, footprintOutlineRings } from '../src/firmsDetections.js'

const origin = { latitude: 50, longitude: 6 }
const high = { label: 'high', rank: 3, raw: 95 }
const nominal = { label: 'nominal', rank: 2, raw: 60 }
const detection = ({
  acquiredAt,
  longitude = origin.longitude,
  latitude = origin.latitude,
  confidence = high,
  satellite = 'Terra',
  sensorKey = 'modis',
  scanKm = 1,
  trackKm = 1,
}) => ({
  acquiredAt,
  longitude,
  latitude,
  confidence,
  satellite,
  sensorKey,
  scanKm,
  trackKm,
})

const core = detection({
  acquiredAt: '2026-08-15T10:00:00.000Z',
  sensorKey: 'viirsNoaa20',
  scanKm: 0.375,
  trackKm: 0.375,
})
const previousPass = detection({ acquiredAt: '2026-08-15T11:58:00.000Z' })
const latestNearCore = detection({
  acquiredAt: '2026-08-15T12:02:00.000Z',
  longitude: 6.008,
})
const latestNearAircraft = detection({
  acquiredAt: '2026-08-15T12:02:30.000Z',
  longitude: 6.025,
})
const latestRemote = detection({
  acquiredAt: '2026-08-15T12:03:00.000Z',
  longitude: 6.06,
})
const latestNominal = detection({
  acquiredAt: '2026-08-15T12:02:00.000Z',
  longitude: 6.004,
  confidence: nominal,
})
const futurePass = detection({
  acquiredAt: '2026-08-15T12:07:00.000Z',
  longitude: 6.07,
  satellite: 'Aqua',
})
const detections = [previousPass, latestNearCore, latestNearAircraft, latestRemote, latestNominal, futurePass]
const aircraftEdgeCandidates = [{ position: [50, 6.025] }]

const beforeLatestFrame = deriveModisSupportedExtent({
  detections,
  coreDetections: [core],
  aircraftEdgeCandidates,
  frameTimestampMs: Date.parse('2026-08-15T12:04:59.999Z'),
  origin,
})
assert.equal(beforeLatestFrame.detections.length, 1, 'a pass must not appear before its next five-minute frame')
assert.equal(beforeLatestFrame.passAcquiredAt, previousPass.acquiredAt)

const extent = deriveModisSupportedExtent({
  detections,
  coreDetections: [core],
  aircraftEdgeCandidates,
  frameTimestampMs: Date.parse('2026-08-15T12:05:00.000Z'),
  origin,
})
assert.equal(extent.detections.length, 2, 'core- and aircraft-supported high-confidence pixels should remain')
assert.ok(extent.detections.includes(latestNearCore))
assert.ok(extent.detections.includes(latestNearAircraft))
assert.ok(!extent.detections.includes(latestRemote), 'an unsupported pixel must not extend the incident outline')
assert.ok(!extent.detections.includes(latestNominal), 'nominal-confidence MODIS must not extend the outline')
assert.equal(extent.sourceDetectionCount, 4, 'the complete newest pass count should be retained')
assert.equal(extent.highConfidenceDetectionCount, 3, 'the newest high-confidence pass count should be retained')
assert.equal(extent.passAcquiredAt, latestNearAircraft.acquiredAt)
assert.equal(extent.availableAt, '2026-08-15T12:05:00.000Z')
assert.deepEqual(extent.satellites, ['Terra'])
assert.equal(extent.gridCellM, MODIS_EXTENT_GRID_CELL_M)
assert.equal(extent.timeBucketMs, MODIS_EXTENT_TIME_BUCKET_MS)
assert.equal(Object.hasOwn(extent, 'areaHa'), false, 'coarse support must not produce a hectare figure')

const bestEstimateDetections = [core, ...extent.detections]
const combinedOutlineRings = footprintOutlineRings(bestEstimateDetections, {
  origin,
  gridCellM: MODIS_EXTENT_GRID_CELL_M,
})
assert.ok(combinedOutlineRings.length > 0, 'qualifying MODIS pixels should extend the existing outline union')
assert.ok(
  estimateFootprintArea(bestEstimateDetections, { origin }).unionHa
    > estimateFootprintArea([core], { origin }).unionHa,
  'the displayed area should describe the same extended satellite union',
)

const phi = origin.latitude * Math.PI / 180
const metresPerLatitude = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi)
const metresPerLongitude = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi)
combinedOutlineRings.flat().forEach(([latitude, longitude]) => {
  const xCells = (longitude - origin.longitude) * metresPerLongitude / MODIS_EXTENT_GRID_CELL_M
  const yCells = (latitude - origin.latitude) * metresPerLatitude / MODIS_EXTENT_GRID_CELL_M
  assert.ok(Math.abs(xCells - Math.round(xCells)) < 1e-8, 'longitude should use the shared 50 m grid')
  assert.ok(Math.abs(yCells - Math.round(yCells)) < 1e-8, 'latitude should use the shared 50 m grid')
})

const coreOnlySupport = deriveModisSupportedExtent({
  detections,
  coreDetections: [core],
  frameTimestampMs: Date.parse('2026-08-15T12:05:00.000Z'),
  origin,
})
assert.deepEqual(coreOnlySupport.detections, [latestNearCore], 'aircraft support must be explicit')

const noCore = deriveModisSupportedExtent({
  detections,
  aircraftEdgeCandidates,
  frameTimestampMs: Date.parse('2026-08-15T12:05:00.000Z'),
  origin,
})
assert.deepEqual(noCore.detections, [], 'MODIS cannot create a Best estimate without a VIIRS core')

const unsupportedNewest = deriveModisSupportedExtent({
  detections,
  coreDetections: [core],
  aircraftEdgeCandidates,
  frameTimestampMs: Date.parse('2026-08-15T12:10:00.000Z'),
  origin,
})
assert.equal(unsupportedNewest.detections.length, 0, 'an unsupported newest pass must not fall back to stale coarse geometry')
assert.equal(unsupportedNewest.passAcquiredAt, futurePass.acquiredAt)

const nominalNewest = deriveModisSupportedExtent({
  detections: [previousPass, detection({
    acquiredAt: '2026-08-15T12:12:00.000Z',
    confidence: nominal,
  })],
  coreDetections: [core],
  frameTimestampMs: Date.parse('2026-08-15T12:15:00.000Z'),
  origin,
})
assert.equal(nominalNewest.detections.length, 0, 'a newer nominal-only pass must not carry an older high-confidence extent forward')
assert.equal(nominalNewest.highConfidenceDetectionCount, 0)

console.log('MODIS-supported fire-extent checks passed')
