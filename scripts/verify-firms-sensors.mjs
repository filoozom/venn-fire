#!/usr/bin/env node

// Checks the FIRMS sensor definitions and parsing against fixtures with known
// answers. Runs without a MAP_KEY and without contacting NASA.

import {
  FIRMS_SENSORS,
  buildFirmsRequests,
  corroborateDetections,
  estimateFootprintArea,
  footprintOutlineRings,
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
const meteosat = FIRMS_SENSORS.find((sensor) => sensor.key === 'meteosat')

// --- which sensors may produce an area figure --------------------------------

check('viirs yields area', viirs.providesArea, true)
check('modis yields no area', modis.providesArea, false)
check('geostationary yields no area', meteosat.providesArea, false)
check('geostationary maps to the FIRMS product key', meteosat.apiSource, 'GOES_NRT')

// --- per-sensor day-range caps ------------------------------------------------

let capped = false
try {
  buildFirmsRequests({ mapKey: 'k', bbox: [0, 0, 1, 1], startDate: '2026-08-15', dayRange: 3, sensors: [meteosat] })
} catch {
  capped = true
}
check('geostationary rejects dayRange over 2', capped, true)
check('geostationary accepts dayRange 2', buildFirmsRequests({
  mapKey: 'k', bbox: [0, 0, 1, 1], startDate: '2026-08-15', dayRange: 2, sensors: [meteosat],
}).length, 1)
check('polar still accepts a long window', buildFirmsRequests({
  mapKey: 'k', bbox: [0, 0, 1, 1], startDate: '2026-08-15', dayRange: 7, sensors: [viirs],
}).length, 1)
check('citable url withholds the key', buildFirmsRequests({
  mapKey: 'SECRET', bbox: [0, 0, 1, 1], startDate: '2026-08-15', dayRange: 1, sensors: [viirs],
})[0].citableUrl.includes('SECRET'), false)

// --- confidence scales --------------------------------------------------------

// The two Meteosat generations disagree on units. Both were confirmed against a
// day of real detections: Met12 reported 0.01-1.0, Met9 and Met10 reported
// 52-100. Keying on the spacecraft rather than the magnitude matters, because a
// genuine 1 percent from an MSG satellite would otherwise read as certainty.
const GEO_CSV = [
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight',
  '50.54762,6.05757,340.1,0,0,2026-08-15,1119,Met12,,0.918,1.11NRT,301.2,26.7,D',
  '50.54800,6.05800,340.1,0,0,2026-08-15,1119,Met12,,0.20,1.11NRT,301.2,4.0,D',
  '50.54900,6.05900,340.1,0,0,2026-08-15,1119,Met10,,88,1.11NRT,301.2,30.0,D',
  '50.55000,6.06000,340.1,0,0,2026-08-15,1119,Met10,,20,1.11NRT,301.2,3.0,D',
].join('\n')
const geo = parseFirmsCsv(GEO_CSV, meteosat)
check('mtg fraction 0.918 reads as high', geo.detections[0].confidence.label, 'high')
check('mtg fraction 0.20 reads as low', geo.detections[1].confidence.label, 'low')
check('msg percent 88 reads as high', geo.detections[2].confidence.label, 'high')
check('msg percent 20 reads as low', geo.detections[3].confidence.label, 'low')

const VIIRS_CSV = [
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight',
  '50.54762,6.05757,340.1,0.375,0.375,2026-08-14,1312,N,VIIRS,n,2.0NRT,295.3,12.4,D',
  '50.55100,6.06200,367.8,0.375,0.375,2026-08-14,1312,N,VIIRS,h,2.0NRT,301.2,48.9,D',
  'not-a-number,6.05,,,,2026-08-14,1454,N,VIIRS,n,2.0NRT,,,D',
].join('\n')
const parsed = parseFirmsCsv(VIIRS_CSV, viirs)
check('viirs letter confidence normalised', parsed.detections[1].confidence.label, 'high')
check('malformed row skipped, not guessed', parsed.skippedRows, 1)

// --- footprints ---------------------------------------------------------------

// Geostationary rows arrive with scan/track of 0, so the footprint has to fall
// back to the nominal pixel and say that it did.
check('zero pixel dimensions fall back to nominal', geo.detections[0].scanKm, 3)
check('the fallback is flagged', geo.detections[0].footprintSource, 'nominal')
check('published dimensions are kept', parsed.detections[0].scanKm, 0.375)

const geoSummary = summarizeSensorDetections({
  sensor: meteosat,
  detections: geo.detections,
  minimumConfidence: 'low',
  origin: { latitude: 50.54762, longitude: 6.05757 },
})
check('geostationary summary forbids area derivation', geoSummary.areaDerivationAllowed, false)
check('geostationary summary contains no hectare figure', geoSummary.areaHa, null)
check('geostationary confidence areas are suppressed', geoSummary.areaHaByConfidence, null)
check('geostationary mean pixel hectares are suppressed', geoSummary.meanPixelHa, null)
check('geostationary renders as an exact centroid', geoSummary.displayMode, 'centroid')

// A 375 m pixel is 14.0625 ha, and the grid union reproduces it exactly.
const single = estimateFootprintArea([parsed.detections[0]], { origin: parsed.detections[0] })
check('single pixel union is exact', single.unionHa, 14.0625, 0.001)

// --- corroboration ------------------------------------------------------------

const at = (lat, lon, sensorKey, extra = {}) => ({
  latitude: lat, longitude: lon, sensorKey, scanKm: 0.375, trackKm: 0.375,
  acquiredAt: '2026-08-15T00:35:00.000Z',
  confidence: { label: 'nominal', rank: 2, raw: 'n' },
  frpMw: 2.5, satellite: 'test', footprintSource: 'published', ...extra,
})

const pair = corroborateDetections([at(50.54, 6.08, 'viirsNoaa20'), at(50.5401, 6.0801, 'viirsSnpp')])
check('two satellites over one cell corroborate', pair.every((d) => d.isCorroborated), true)
const alone = corroborateDetections([at(50.54, 6.00, 'viirsNoaa20'), at(50.5401, 6.0001, 'viirsNoaa20')])
check('one satellite alone does not corroborate', alone.some((d) => d.isCorroborated), false)

// Coarse sensors must never corroborate a 375 m location.
const geoMix = corroborateDetections([
  at(50.54, 6.08, 'viirsNoaa20'),
  at(50.5401, 6.0801, 'meteosat', { scanKm: 3, trackKm: 3 }),
])
check('geostationary does not corroborate viirs', geoMix[0].isCorroborated, false)
check('geostationary is excluded, not scored', geoMix[1].corroboratingSensors, null)
const modisMix = corroborateDetections([
  at(50.54, 6.08, 'viirsNoaa20'),
  at(50.5401, 6.0801, 'modis', { scanKm: 1, trackKm: 1 }),
])
check('modis does not corroborate viirs', modisMix[0].isCorroborated, false)

// --- outline ------------------------------------------------------------------

const origin = { latitude: 50.54, longitude: 6.08 }
const ring = footprintOutlineRings([at(50.54, 6.08, 'viirsSnpp')], { origin, gridCellM: 25 })
check('a single footprint traces one closed ring', ring.length, 1)
check('the ring closes', JSON.stringify(ring[0][0]), JSON.stringify(ring[0].at(-1)))
check('no detections yields no rings', footprintOutlineRings([], { origin }).length, 0)

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
