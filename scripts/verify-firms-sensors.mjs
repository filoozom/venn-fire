#!/usr/bin/env node

// Checks the FIRMS sensor definitions and parsing against fixtures with known
// answers. Runs without a MAP_KEY and without contacting NASA.

import {
  FIRMS_SENSORS,
  buildFirmsRequests,
  corroborateDetections,
  detectionFootprint,
  estimateFootprintArea,
  firmsDetectionOpacityAt,
  firmsDetectionVisibleAt,
  footprintOutlineRings,
  geostationaryPixelKm,
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
  '50.54900,6.05900,340.1,332,1991,2026-08-15,1119,Met10,,88,1.11NRT,301.2,30.0,D',
  '50.55000,6.06000,340.1,332,1991,2026-08-15,1119,Met10,,20,1.11NRT,301.2,3.0,D',
  '50.55100,6.06100,340.1,371,1070,2026-08-15,1119,Met9,,1,1.11NRT,301.2,3.0,D',
  '50.55200,6.06200,340.1,330,1900,2026-08-15,1119,Met11,,1,1.11NRT,301.2,3.0,D',
  '50.55300,6.06300,340.1,400,2000,2026-08-15,1119,Unknown,,88,1.11NRT,301.2,3.0,D',
].join('\n')
const geo = parseFirmsCsv(GEO_CSV, meteosat)
check('mtg fraction 0.918 reads as high', geo.detections[0].confidence.label, 'high')
check('mtg fraction 0.20 reads as low', geo.detections[1].confidence.label, 'low')
check('msg percent 88 reads as high', geo.detections[2].confidence.label, 'high')
check('msg percent 20 reads as low', geo.detections[3].confidence.label, 'low')
check('met9 percent 1 stays low', geo.detections[4].confidence.label, 'low')
check('met11 is MSG and percent 1 stays low', geo.detections[5].confidence.label, 'low')

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

// Met12 supplies zeroes in these columns, while MSG rows carry image-grid
// coordinates. Neither is a physical dimension, so the ground footprint is
// approximated from the platform's service longitude and viewing geometry.
check('zero dimensions are computed, not assumed nominal', geo.detections[0].footprintSource, 'computed-geostationary')
check('geostationary image-grid scan is retained but not treated as km', geo.detections[2].sourceScan, 332)
check('geostationary image-grid track is retained but not treated as km', geo.detections[2].sourceTrack, 1991)
check('geostationary image-grid fields still yield computed dimensions', geo.detections[2].footprintSource, 'computed-geostationary')
check('mtg pixel is stretched north-south', geo.detections[0].trackKm > geo.detections[0].scanKm * 1.5, true)
check('mtg pixel is about 876 ha', geo.detections[0].scanKm * geo.detections[0].trackKm * 100, 876, 5)
check('msg pixel is about 1972 ha', geo.detections[2].scanKm * geo.detections[2].trackKm * 100, 1972, 10)
check('msg pixel is larger than mtg', geo.detections[2].scanKm > geo.detections[0].scanKm, true)
check('met9 Indian Ocean pixel is about 3010 ha', geo.detections[4].scanKm * geo.detections[4].trackKm * 100, 3010, 15)
check('met9 uses the 45.5 east service', geo.detections[4].subSatelliteLongitude, 45.5)
check('met10 uses the zero-degree service', geo.detections[2].subSatelliteLongitude, 0)
check('met11 remains a 3 km MSG platform', geo.detections[5].scanKm > 3, true)
check('unknown geostationary platform is not given a guessed footprint', geo.detections[6].displayMode, 'centroid')

const met9Ring = detectionFootprint(geo.detections[4])
const met9LatitudeSpan = Math.max(...met9Ring.map(([latitude]) => latitude)) - Math.min(...met9Ring.map(([latitude]) => latitude))
const met9LongitudeSpan = Math.max(...met9Ring.map(([, longitude]) => longitude)) - Math.min(...met9Ring.map(([, longitude]) => longitude))
check('met9 footprint is rotated toward its Indian Ocean sub-satellite point', met9LongitudeSpan > met9LatitudeSpan, true)

// Sanity-check the geometry itself against the known viewing angle from Belgium.
const geoPixel = geostationaryPixelKm('Met10', 50.548, 6.058)
check('viewing zenith from Belgium is about 58 degrees', geoPixel.viewingZenithDeg, 58.2, 0.3)
check('met11 is not misclassified as MTG', geostationaryPixelKm('Met11', 50.548, 6.058).generation, 'msg')

// Visibility defaults: coarse sensors start hidden.
check('geostationary is hidden by default', meteosat.defaultVisible, false)
check('modis is hidden by default', modis.defaultVisible, false)
check('viirs is shown by default', viirs.defaultVisible, true)
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
check('known geostationary platforms use an approximate footprint, not a dot', meteosat.displayMode, 'footprint')
const scanTime = Date.parse('2026-08-15T11:19:00.000Z')
check('geostationary scan is hidden before acquisition', firmsDetectionVisibleAt(geo.detections[0], scanTime - 1), false)
check('geostationary scan is visible during its 15-minute window', firmsDetectionVisibleAt(geo.detections[0], scanTime + 14 * 60_000), true)
check('geostationary scan expires after 15 minutes', firmsDetectionVisibleAt(geo.detections[0], scanTime + 15 * 60_000), false)
const polarTime = Date.parse(parsed.detections[0].acquiredAt)
check('polar overpass remains visible just under 24 hours', firmsDetectionVisibleAt(parsed.detections[0], polarTime + 24 * 60 * 60_000 - 1), true)
check('polar overpass expires at 24 hours', firmsDetectionVisibleAt(parsed.detections[0], polarTime + 24 * 60 * 60_000), false)
check('polar overpass fades to half opacity after 12 hours', firmsDetectionOpacityAt(parsed.detections[0], polarTime + 12 * 60 * 60_000), 0.5)

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
