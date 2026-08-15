#!/usr/bin/env node

// Verifies the FIRMS detection module against fixtures with analytically known
// answers. It runs without a MAP_KEY and without contacting NASA, so the derived
// hectare figure can be checked before any real response is ever plotted.

import {
  FIRMS_SENSORS,
  buildFirmsRequests,
  footprintOutlineRings,
  corroborateDetections,
  detectionFootprint,
  estimateFootprintArea,
  parseFirmsCsv,
  summarizeSensorDetections,
} from '../src/firmsDetections.js'

let failures = 0

function check(label, actual, expected, tolerance = 0) {
  const ok = typeof expected === 'number'
    ? Math.abs(actual - expected) <= tolerance
    : actual === expected
  if (!ok) {
    failures += 1
    console.error(`FAIL  ${label}\n      expected ${expected}, got ${actual}`)
    return
  }
  console.log(`ok    ${label}`)
}

const viirs = FIRMS_SENSORS.find((sensor) => sensor.key === 'viirsSnpp')
const modis = FIRMS_SENSORS.find((sensor) => sensor.key === 'modis')

// A 375 m VIIRS pixel is 0.375 x 0.375 km = 14.0625 ha.
const SINGLE_PIXEL_HA = 14.0625

// --- request building -------------------------------------------------------

const requests = buildFirmsRequests({
  mapKey: 'TEST_KEY',
  bbox: [5.90, 50.50, 6.16, 50.66],
  startDate: '2026-08-14',
  dayRange: 2,
})
check('one request per sensor', requests.length, FIRMS_SENSORS.length)
check('request targets the sensor product', requests[0].url.includes('/VIIRS_SNPP_NRT/'), true)
check('citable url withholds the key', requests[0].citableUrl.includes('TEST_KEY'), false)

let rejected = false
try {
  buildFirmsRequests({ mapKey: '', bbox: [0, 0, 1, 1], startDate: '2026-08-14' })
} catch {
  rejected = true
}
check('missing key is rejected', rejected, true)

rejected = false
try {
  buildFirmsRequests({ mapKey: 'k', bbox: [0, 0, 1, 1], startDate: '2026-08-14', dayRange: 99 })
} catch {
  rejected = true
}
check('out-of-range dayRange is rejected', rejected, true)

// --- parsing ----------------------------------------------------------------

const VIIRS_CSV = [
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight',
  '50.54762,6.05757,340.1,0.375,0.375,2026-08-14,1312,N,VIIRS,n,2.0NRT,295.3,12.4,D',
  '50.55100,6.06200,367.8,0.375,0.375,2026-08-14,1312,N,VIIRS,h,2.0NRT,301.2,48.9,D',
  '50.54000,6.05000,301.4,0.375,0.375,2026-08-14,1454,N,VIIRS,l,2.0NRT,288.1,3.1,D',
  'not-a-number,6.05,,,,2026-08-14,1454,N,VIIRS,n,2.0NRT,,,D',
].join('\n')

const parsed = parseFirmsCsv(VIIRS_CSV, viirs)
check('valid rows parsed', parsed.detections.length, 3)
check('malformed row skipped, not guessed', parsed.skippedRows, 1)
check('acq_time becomes UTC iso', parsed.detections[0].acquiredAt, '2026-08-14T13:12:00.000Z')
check('viirs confidence normalised', parsed.detections[1].confidence.label, 'high')
check('frp retained', parsed.detections[1].frpMw, 48.9)
check('published footprint flagged', parsed.detections[0].footprintSource, 'published')

// A row without scan/track must fall back to the nominal pixel, flagged as such.
const NO_FOOTPRINT_CSV = [
  'latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight',
  '50.54762,6.05757,330.0,,,2026-08-14,1312,Terra,MODIS,85,6.1NRT,290.0,20.0,D',
].join('\n')
const modisParsed = parseFirmsCsv(NO_FOOTPRINT_CSV, modis)
check('missing footprint falls back to nominal', modisParsed.detections[0].scanKm, 1)
check('fallback is flagged', modisParsed.detections[0].footprintSource, 'nominal')
check('modis numeric confidence normalised', modisParsed.detections[0].confidence.label, 'high')

// --- footprint geometry -----------------------------------------------------

const [footprintDetection] = parseFirmsCsv(VIIRS_CSV, viirs).detections
const ring = detectionFootprint(footprintDetection)
check('footprint ring is closed', JSON.stringify(ring[0]), JSON.stringify(ring[4]))
check('footprint ring has 5 points', ring.length, 5)

// 0.375 km north-south, checked against the local metres-per-degree scale.
const heightDegrees = ring[2][0] - ring[0][0]
check('footprint height is 375 m', heightDegrees * 111238, 375, 1)

// --- area estimate ----------------------------------------------------------

const single = estimateFootprintArea([footprintDetection], { origin: footprintDetection })
check('single pixel union is exact on a 25 m grid', single.unionHa, SINGLE_PIXEL_HA, 0.001)
check('single pixel sum equals union', single.sumHa, SINGLE_PIXEL_HA, 0.001)
check('single pixel has no overlap', single.overlapFactor, 1, 0.001)

// Two detections at the identical location are two observations of one patch of
// ground. The union must not double it; the sum must.
const duplicate = { ...footprintDetection, acquiredAt: '2026-08-14T14:54:00.000Z' }
const overlapping = estimateFootprintArea([footprintDetection, duplicate], { origin: footprintDetection })
check('repeat overpass does not double the union', overlapping.unionHa, SINGLE_PIXEL_HA, 0.001)
check('naive sum does double', overlapping.sumHa, SINGLE_PIXEL_HA * 2, 0.001)
check('overlap factor exposes the duplication', overlapping.overlapFactor, 2, 0.001)

// Two footprints placed exactly one pixel apart must not overlap at all.
const eastward = {
  ...footprintDetection,
  longitude: footprintDetection.longitude + 375 / (111412.84 * Math.cos(footprintDetection.latitude * Math.PI / 180) - 93.5 * Math.cos(3 * footprintDetection.latitude * Math.PI / 180)),
}
const adjacent = estimateFootprintArea([footprintDetection, eastward], { origin: footprintDetection })
check('adjacent pixels sum without overlap', adjacent.unionHa, SINGLE_PIXEL_HA * 2, 0.05)

check('empty input yields zero, not NaN', estimateFootprintArea([]).unionHa, 0)

// --- summary ----------------------------------------------------------------

const summary = summarizeSensorDetections({
  sensor: viirs,
  detections: parsed.detections,
  skippedRows: parsed.skippedRows,
  requestUrl: requests[0].citableUrl,
  retrievedAt: '2026-08-15T10:00:00.000Z',
  minimumConfidence: 'nominal',
})
check('low confidence excluded at nominal threshold', summary.detectionCount, 2)
check('exclusions are reported, not hidden', summary.droppedByConfidence, 1)
check('confidence breakdown retained', summary.confidenceCounts.low, 1)
check('estimate is flagged as an estimate', summary.areaIsEstimate, true)
check('estimate carries its method', summary.areaMethod.includes('25 m grid'), true)
check('estimate is not labelled burned area', summary.areaDisclaimer.includes('Not a burned area'), true)
check('estimate carries its source', summary.source, 'NASA FIRMS')
check('estimate carries its request url', summary.sourceRequestUrl, requests[0].citableUrl)
check('caveats travel with the figure', summary.caveats.length > 0, true)
check('single pixel size published for scale', summary.singlePixelHa, SINGLE_PIXEL_HA, 0.001)
check('window start reported', summary.firstAcquiredAt, '2026-08-14T13:12:00.000Z')

// --- corroboration ------------------------------------------------------------

const at = (latitude, longitude, sensorKey) => ({
  latitude, longitude, sensorKey, scanKm: 0.375, trackKm: 0.375,
  acquiredAt: '2026-08-15T00:35:00.000Z',
  confidence: { label: 'nominal', rank: 2, raw: 'n' },
  frpMw: 2.5, brightnessK: null, dayNight: 'N', satellite: 'test', footprintSource: 'published',
})

// Two different satellites over the same spot corroborate each other.
const together = corroborateDetections([
  at(50.5400, 6.0800, 'viirsNoaa20'),
  at(50.5401, 6.0801, 'viirsSnpp'),
])
check('same cell, two satellites is corroborated', together.every((d) => d.isCorroborated), true)
check('corroborating satellite count is reported', together[0].corroboratingSensors, 2)

// The west-side case: many detections, all from one satellite.
const onePass = corroborateDetections([
  at(50.5400, 6.0000, 'viirsNoaa20'),
  at(50.5401, 6.0001, 'viirsNoaa20'),
  at(50.5402, 6.0002, 'viirsNoaa20'),
])
check('one satellite alone is not corroborated', onePass.some((d) => d.isCorroborated), false)
check('repeat passes of one satellite do not self-corroborate', onePass[0].corroboratingSensors, 1)

// Distant detections from two satellites are not the same location.
const apart = corroborateDetections([
  at(50.5400, 6.0800, 'viirsNoaa20'),
  at(50.5400, 6.2000, 'viirsSnpp'),
])
check('different cells do not corroborate', apart.some((d) => d.isCorroborated), false)

// MODIS is too coarse to place a 375 m detection, so it neither corroborates nor
// is corroborated.
const withModis = corroborateDetections([
  at(50.5400, 6.0800, 'viirsNoaa20'),
  at(50.5401, 6.0801, 'modis'),
])
check('modis does not corroborate viirs', withModis[0].isCorroborated, false)
check('modis is excluded, not scored', withModis[1].corroboratingSensors, null)
check('modis is never in the corroborated set', withModis[1].isCorroborated, false)

// --- fire core (best estimate) --------------------------------------------

const high = (latitude, longitude, sensorKey) => ({
  ...at(latitude, longitude, sensorKey),
  confidence: { label: 'high', rank: 3, raw: 'h' },
})

// Two satellites plus a high-confidence detection anchors the cell.
const anchored = corroborateDetections([
  high(50.5400, 6.0800, 'viirsNoaa20'),
  at(50.5401, 6.0801, 'viirsSnpp'),
])
check('cell with 2 sats and a high-confidence hit is fire core', anchored.every((d) => d.isFireCore), true)
check('nominal detection in an anchored cell is kept', anchored[1].isFireCore, true)

// Corroborated but with no high-confidence detection anywhere in the cell.
const unanchored = corroborateDetections([
  at(50.5400, 6.0800, 'viirsNoaa20'),
  at(50.5401, 6.0801, 'viirsSnpp'),
])
check('corroborated without high confidence is not fire core', unanchored.some((d) => d.isFireCore), false)
check('...but it is still corroborated', unanchored.every((d) => d.isCorroborated), true)

// High confidence from a single satellite is not enough on its own.
const loneHigh = corroborateDetections([high(50.5400, 6.0000, 'viirsNoaa20')])
check('high confidence from one satellite is not fire core', loneHigh[0].isFireCore, false)

// --- outline ----------------------------------------------------------------

const origin = { latitude: 50.54, longitude: 6.08 }
const oneRing = footprintOutlineRings([at(50.5400, 6.0800, 'viirsSnpp')], { origin, gridCellM: 25 })
check('a single footprint traces one ring', oneRing.length, 1)
check('the ring is closed', JSON.stringify(oneRing[0][0]), JSON.stringify(oneRing[0].at(-1)))
check('a rectangle needs only its corners', oneRing[0].length, 5)

// Two touching footprints must dissolve into one boundary, not two.
const mPerLon = 111412.84 * Math.cos(50.54 * Math.PI / 180) - 93.5 * Math.cos(3 * 50.54 * Math.PI / 180)
const merged = footprintOutlineRings([
  at(50.5400, 6.0800, 'viirsSnpp'),
  at(50.5400, 6.0800 + 375 / mPerLon, 'viirsSnpp'),
], { origin, gridCellM: 25 })
check('touching footprints dissolve into one ring', merged.length, 1)

// A ring around a gap must be reported separately rather than filled in.
const far = footprintOutlineRings([
  at(50.5400, 6.0800, 'viirsSnpp'),
  at(50.5400, 6.1200, 'viirsSnpp'),
], { origin, gridCellM: 25 })
check('separate patches stay separate', far.length, 2)

check('no detections yields no rings', footprintOutlineRings([], { origin }).length, 0)

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
