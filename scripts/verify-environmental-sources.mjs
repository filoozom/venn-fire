#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'

import {
  CAMS_AOI_BOUNDS,
  dwdRadarArchiveUrl,
  dwdRadolanValueMm,
  encodeRgbaPng,
  extractWmsLayerTime,
  geometryContainsIncident,
  pairSentinel1Scenes,
  parseCamsFeatureInfo,
  parseDwdRadarArchiveDates,
  parseDwdRadolanYwFrame,
  parseRmiRadarPayload,
  rmiRadarIncidentCategory,
} from '../server/environmental-sources.mjs'
import { mergePrecipitationRadar } from '../src/data.js'

const radarBody = Buffer.alloc(6 + 8 + 2)
radarBody.writeUInt16BE(2, 0)
radarBody.writeUInt16BE(1, 2)
radarBody[4] = 3
radarBody[5] = 1
radarBody.writeBigUInt64LE(BigInt(Date.parse('2026-08-17T17:20:00.000Z') / 1_000), 6)
radarBody[14] = 2 | (5 << 3)
const radar = parseRmiRadarPayload(gzipSync(radarBody))
assert.equal(radar.width, 2)
assert.equal(radar.height, 1)
assert.equal(radar.observedTimes[0], '2026-08-17T17:20:00.000Z')
assert.deepEqual(rmiRadarIncidentCategory(radar, 0), {
  value: 5,
  label: 'heavy',
  pixel: { x: 1, y: 0 },
})

const dwdHeader = Buffer.from('YW140000100000826BY0000000VS 2SW 2.29.1PR E-02INT 5GP 2x 2 ')
const dwdValues = Buffer.alloc(8)
dwdValues.writeUInt16LE(0, 0)
dwdValues.writeUInt16LE(123, 2)
dwdValues.writeUInt16LE(0x2000 | 2500, 4)
dwdValues.writeUInt16LE(0x1000 | 50, 6)
const dwdFrame = parseDwdRadolanYwFrame(
  Buffer.concat([dwdHeader, Buffer.from([3]), dwdValues]),
  'raa01-yw_10000-2608141205-dwd---bin',
)
assert.equal(dwdFrame.observedAt, '2026-08-14T12:05:00.000Z')
assert.equal(dwdFrame.intervalMinutes, 5)
assert.deepEqual([0, 1, 2, 3].map((index) => dwdRadolanValueMm(dwdFrame, index)), [0, 1.23, null, 0.5])
assert.deepEqual(parseDwdRadarArchiveDates(`
  <a href="YW-260814.tar.gz">YW-260814.tar.gz</a>
  <a href="YW-260815.tar.gz">YW-260815.tar.gz</a>
`), ['2026-08-14', '2026-08-15'])
assert.equal(dwdRadarArchiveUrl('2026-08-14'),
  'https://opendata.dwd.de/climate_environment/CDC/grids_germany/5_minutes/radolan/recent/YW-260814.tar.gz')

const mergedRadar = mergePrecipitationRadar({
  bounds: [[48, 0], [52, 7]],
  frames: [{ observedAt: '2026-08-14T12:10:00.000Z', incident: { label: 'RMI' } }],
}, {
  bounds: [[50.3, 5.7], [50.8, 6.4]],
  completedDates: ['2026-08-14'],
  frames: [
    { observedAt: '2026-08-14T12:05:00.000Z', incident: { label: 'DWD' } },
    { observedAt: '2026-08-14T12:10:00.000Z', incident: { label: 'DWD duplicate' } },
  ],
})
assert.deepEqual(mergedRadar.frames.map((frame) => frame.observedAt), [
  '2026-08-14T12:05:00.000Z',
  '2026-08-14T12:10:00.000Z',
])
assert.equal(mergedRadar.frames.at(-1).incident.label, 'RMI')
assert.equal(mergedRadar.frames[0].providerKey, 'dwd-radolan-yw')
assert.equal(mergedRadar.historicalBackfill.frameCount, 2)

const png = encodeRgbaPng(1, 1, Buffer.from([10, 20, 30, 255]))
assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR')

const timeDimension = extractWmsLayerTime(`
  <Layer queryable="1">
    <Name>composition_europe_pm_wf_forecast_surface</Name>
    <Dimension name="time" default="2026-08-17T00:00:00Z" units="ISO8601">2026-07-19T00:00:00Z,2026-07-19T01:00:00Z/2026-08-21T00:00:00Z/PT1H</Dimension>
  </Layer>
`, 'composition_europe_pm_wf_forecast_surface')
assert.equal(timeDimension.defaultTime, '2026-08-17T00:00:00Z')
assert(timeDimension.values.endsWith('/PT1H'))

assert.deepEqual(parseCamsFeatureInfo(`
Name: composition_europe_pm_wf_forecast_surface
Value: 1.88173 µg/m3
Grid point latitude: 50.55
Grid point longitude: 6.05
`), {
  value: 1.88173,
  unit: 'µg/m³',
  gridPoint: { latitude: 50.55, longitude: 6.05 },
})
assert.deepEqual(CAMS_AOI_BOUNDS, [[49.5, 4.5], [51.5, 7.5]])

const incidentGeometry = {
  type: 'Polygon',
  coordinates: [[[5.9, 50.4], [6.2, 50.4], [6.2, 50.7], [5.9, 50.7], [5.9, 50.4]]],
}
assert.equal(geometryContainsIncident(incidentGeometry), true)
assert.equal(geometryContainsIncident({
  type: 'Polygon',
  coordinates: [[[7, 51], [8, 51], [8, 52], [7, 52], [7, 51]]],
}), false)

const pairs = pairSentinel1Scenes([{
  id: 'pre',
  acquiredAt: '2026-08-04T17:24:00.000Z',
  platform: 'sentinel-1d',
  relativeOrbit: 88,
  orbitState: 'ascending',
}, {
  id: 'wrong-orbit',
  acquiredAt: '2026-08-10T17:24:00.000Z',
  platform: 'sentinel-1d',
  relativeOrbit: 87,
  orbitState: 'ascending',
}, {
  id: 'post',
  acquiredAt: '2026-08-16T17:24:00.000Z',
  platform: 'sentinel-1d',
  relativeOrbit: 88,
  orbitState: 'ascending',
}])
assert.equal(pairs.length, 1)
assert.equal(pairs[0].preSceneId, 'pre')
assert.equal(pairs[0].postSceneId, 'post')
assert.equal(pairs[0].separationDays, 12)

const [appSource, mapSource, styles] = await Promise.all([
  readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/MapView.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
])
assert.match(appSource, /\[ENVIRONMENT_LAYER_KEYS\.rmiRadar\]: true/u)
assert.match(appSource, /label: 'Precipitation radar'/u)
assert.match(appSource, /aria-label=\{measureMode \? 'Stop measuring distance' : 'Measure distance'\}/u)
assert.match(appSource, /currentCamsWildfirePm10\.bounds \?\? runtime\.cams\.bounds/u)
assert.match(mapSource, /map\.distance\(previous\.latlng, latlng\)/u)
assert.match(mapSource, /clearMeasurement/u)
assert.match(styles, /environmental-raster--cams-wildfire-pm10/u)
assert.match(styles, /mask-image: radial-gradient/u)

console.log('Verified: retained RMI/DWD precipitation history, radar defaults, CAMS semantics/feathering, distance measurement, PNG output, and conservative Sentinel pairing.')
