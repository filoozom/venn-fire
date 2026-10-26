import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import proj4 from 'proj4'
import { createWmsHandler } from '../api/wms.js'
import { mergeIncidentFlights, runtimeDataFromResponse, windFrameAt } from '../src/data.js'
import { bestEstimateAt, environmentalStateAt, firmsDetectionsForMap, footprintOriginFor } from '../src/mapState.js'
import { mapRequest, wmsLayers, wmsParameters } from '../server/wms.mjs'
import { pixelPosition, reprojectRaster } from '../server/wms-render.mjs'

const time = '2026-08-17T12:00:00.000Z'
const timeMs = Date.parse(time)
const at = (minutes) => new Date(timeMs + minutes * 60_000).toISOString()
const bounds = [[50.50, 6.00], [50.60, 6.10]]
const ring = [[50.54, 6.04], [50.54, 6.06], [50.56, 6.06], [50.56, 6.04], [50.54, 6.04]]
const image = { artifactKey: 'fixture-image', databaseUrl: '/api/source-image?id=fixture' }
const detection = (sensorKey, acquiredAt = time, latitude = 50.55, confidence = 'high') => ({
  sensorKey, acquiredAt, latitude, longitude: 6.05, scanKm: 0.375, trackKm: 0.375,
  confidence: { label: confidence, rank: confidence === 'high' ? 2 : 0 },
})
const payloads = {
  'incident-config': { timelineStartMs: timeMs - 5 * 60_000, incidentCenter: [50.55, 6.05], protectedArea: ring },
  'weather-open-meteo': { rows: [{ observedAt: at(5), windSpeed: 10, windDirection: 90 }] },
  'weather-rmi': { station: { latitude: 50.55, longitude: 6.05 }, observations: [{ observedAt: time, wind_speed_10m_kmh: 10, wind_direction: 90 }] },
  'weather-dwd': { stations: [{ id: '123', name: 'Test & station', latitude: 50.55, longitude: 6.05 }], observations: [{ stationId: '123', observedAt: time, windSpeedKmh: 10, windDirection: 90 }] },
  reports: { areaReports: [] },
  firms: { detections: [detection('viirsSnpp'), detection('viirsNoaa20', at(5)), detection('viirsSnpp', time, 50.52, 'low')] },
  effis: { products: [{ productDate: '2026-08-17', rings: [ring] }] },
  aircraft: { observations: [0, 1, 10].map((minute) => ({ icao24: '44c1e5', callSign: 'G10', observedAt: at(minute), latitude: 50.55, longitude: 6.05 + minute * 0.001 })) },
  sentinel2: { analyses: [{ status: 'ready', acquiredAt: at(10), geometry: { type: 'Polygon', coordinates: [ring.map(([lat, lon]) => [lon, lat])] }, supportCells: [[0, 0]], supportCellCount: 1 }] },
  'sentinel3-frp': { detections: [{ latitude: 50.55, longitude: 6.05, acquiredAt: time }] },
  'rmi-radar': { bounds, frames: [{ observedAt: time, image }] },
  'nasa-gibs': { bounds, images: ['true-color', 'false-color'].map((layerKey) => ({ date: '2026-08-17', layerKey, image })) },
  cams: { bounds, frames: ['pm2p5', 'wildfire-pm10'].map((productKey) => ({ validAt: time, forecastRunAt: '2026-08-17T00:00:00Z', productKey, image })) },
}
const datasets = Object.fromEntries(Object.entries(payloads).map(([key, payload]) => [key, { payload }]))
const runtime = runtimeDataFromResponse({ ok: true, generatedAt: at(32 * 24 * 60), datasets }, { singleFrame: true })
assert.equal(runtime.frames.length, 1, 'WMS must not build the entire browser timeline')
const flights = mergeIncidentFlights(runtime.flights, runtime.aircraft.observations)
const detections = firmsDetectionsForMap(runtime.firms.detections, runtime.timelineStartMs)
const layers = wmsLayers(runtime, flights, detections)
let bundle = { runtime, flights, detections, layers, revision: 'fixture-1' }
const red = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#ff0000' } }).png().toBuffer()
let reads = 0
const handler = createWmsHandler({ getSnapshot: async () => bundle, loadImage: async () => { reads += 1; return red } })

function response() {
  return {
    headers: {}, statusCode: 200,
    setHeader(key, value) { this.headers[key.toLowerCase()] = String(value) },
    status(code) { this.statusCode = code; return this },
    end(body) { this.body = body; return this },
  }
}
const defaults = { SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap', LAYERS: 'firms_viirs_snpp', STYLES: '', TIME: time, CRS: 'CRS:84', BBOX: '6,50.5,6.1,50.6', WIDTH: '256', HEIGHT: '256', FORMAT: 'image/png', TRANSPARENT: 'TRUE' }
const query = (changes = {}) => `/wms?${new URLSearchParams({ ...defaults, ...changes })}`
async function invoke(url, { target = handler, method = 'GET', headers = {} } = {}) {
  const result = response()
  await target({ url, method, headers: { host: 'venn.apyos.com', 'x-forwarded-proto': 'https', ...headers } }, result)
  return result
}
const raw = async (bytes) => sharp(bytes).ensureAlpha().raw().toBuffer()
const visible = async (bytes) => (await raw(bytes)).some((value, index) => index % 4 === 3 && value > 0)

const capabilities = await invoke('/wms?service=WMS&request=GetCapabilities')
assert.equal(capabilities.statusCode, 200)
const capabilitiesText = capabilities.body.toString()
assert.match(capabilitiesText, /https:\/\/venn.apyos.com\/wms\?/u)
assert.match(capabilitiesText, /Test &amp; station/u)
assert.match(capabilitiesText, /PT5M<\/Dimension>/u)
assert.equal(new Set(layers.map((layer) => layer.name)).size, layers.length)
for (const name of ['best_estimate', 'aircraft', 'sentinel2_change', 'sentinel3_frp', 'precipitation', 'gibs_true_color', 'gibs_false_color', 'cams_pm25', 'cams_wildfire_pm10', 'wind_model', 'wind_mont_rigi', 'wind_dwd_123', 'protected_area', 'firms_viirs_noaa21_low', 'firms_modis_nominal', 'firms_meteosat_high']) {
  assert.ok(capabilitiesText.includes(`<Name>${name}</Name>`), `Missing layer ${name}`)
}
await writeFile('/tmp/fire-wms-capabilities.xml', capabilities.body)

for (const [changes, code] of [
  [{ LAYERS: '<unknown>' }, 'LayerNotDefined'],
  [{ CRS: 'EPSG:31370' }, 'InvalidCRS'],
  [{ VERSION: '1.1.1' }, 'InvalidParameterValue'],
  [{ STYLES: 'remote' }, 'StyleNotDefined'],
  [{ FORMAT: 'image/jpeg' }, 'InvalidFormat'],
  [{ WIDTH: '99999' }, 'InvalidParameterValue'],
  [{ WIDTH: '2048', HEIGHT: '2048' }, 'InvalidParameterValue'],
  [{ BBOX: '6,50,5,51' }, 'InvalidParameterValue'],
  [{ BBOX: '6,,6.1,50.6' }, 'InvalidParameterValue'],
  [{ BBOX: '0,0,Infinity,1' }, 'InvalidParameterValue'],
  [{ TIME: '2026-02-30T12:00:00Z' }, 'InvalidDimensionValue'],
  [{ TIME: '2026-08-17' }, 'InvalidDimensionValue'],
  [{ TIME: at(1) }, 'InvalidDimensionValue'],
  [{ TIME: at(-10) }, 'InvalidDimensionValue'],
  [{ TIME: at(33 * 24 * 60) }, 'InvalidDimensionValue'],
  [{ TIME: `${time}/${at(5)}` }, 'InvalidDimensionValue'],
]) {
  const result = await invoke(query(changes))
  assert.equal(result.statusCode, 400, JSON.stringify(changes))
  assert.ok(String(result.body).includes(`code="${code}"`), String(result.body))
  assert.equal(result.headers['cache-control'], 'no-store')
}
assert.match(String((await invoke(query({ LAYERS: '<unknown>' }))).body), /&lt;unknown&gt;/u)
assert.equal((await invoke(`${query()}&width=12`)).statusCode, 400)
assert.equal((await invoke(query().replace('&STYLES=', ''))).statusCode, 400)
assert.equal((await invoke('/wms', { method: 'OPTIONS' })).statusCode, 204)
assert.equal((await invoke(query(), { method: 'POST' })).statusCode, 405)

// Coordinates and layer/time selection are verified from rendered pixels, not the SVG implementation.
const high = await invoke(query({ LAYERS: 'firms_viirs_snpp_high' }))
assert.equal(high.statusCode, 200)
assert.equal(high.headers['content-type'], 'image/png')
assert.equal(high.headers['x-wms-time'], time)
assert.ok(await visible(high.body))
const native = await invoke(query({ LAYERS: 'firms_viirs_snpp_high', CRS: 'EPSG:4326', BBOX: '50.5,6,50.6,6.1' }))
assert.deepEqual(await raw(native.body), await raw(high.body), 'WMS 1.3 EPSG:4326 must reverse the BBOX axes')
const low = await invoke(query({ LAYERS: 'firms_viirs_snpp_low' }))
assert.ok(await visible(low.body))
assert.notDeepEqual(await raw(low.body), await raw(high.body), 'Confidence layers must select different observations')
for (const [name, selectedTime] of [
  ['firms_viirs_noaa20', time], ['firms_viirs_snpp', at(-5)], ['firms_viirs_snpp', at(24 * 60)],
  ['best_estimate', time], ['sentinel2_change', time], ['aircraft', at(-5)], ['aircraft', at(25 * 60)],
  ['wind_model', time], ['wind_mont_rigi', at(50)], ['wind_dwd_123', at(95)], ['precipitation', at(60)],
  ['cams_pm25', at(180)], ['sentinel3_frp', at(24 * 60)], ['best_estimate', at(32 * 24 * 60)],
]) {
  const result = await invoke(query({ LAYERS: name, TIME: selectedTime }))
  assert.equal(result.statusCode, 200, `${name}: ${String(result.body).slice(0, 100)}`)
  assert.equal(await visible(result.body), false, `${name} should be empty at ${selectedTime}`)
}
for (const layer of layers.filter((entry) => !entry.confidence && !['firms_viirs_noaa21', 'firms_modis', 'firms_meteosat'].includes(entry.name))) {
  const result = await invoke(query({ LAYERS: layer.name, TIME: at(10) }))
  assert.equal(result.statusCode, 200, `${layer.name}: ${String(result.body).slice(0, 100)}`)
  assert.ok(await visible(result.body), `${layer.name} should render independently`)
}
const state = environmentalStateAt(runtime, timeMs + 10 * 60_000)
const estimate = bestEstimateAt({ detections, sentinelAnalyses: state.visibleSentinelAnalyses, flights, timestampMs: timeMs + 10 * 60_000, origin: footprintOriginFor(runtime) })
assert.ok(estimate.fireActivityAreas.burned.area.unionHa > 0)
assert.equal(windFrameAt(runtime, timeMs).drossartWind, null, 'No future model observation may leak backward')
const combined = await invoke(query({ LAYERS: 'precipitation,best_estimate,aircraft', STYLES: ',,', TIME: at(10) }))
assert.equal(combined.statusCode, 200)
await writeFile('/tmp/fire-wms-preview.png', combined.body)

const cached = await invoke(query({ LAYERS: 'firms_viirs_snpp_high' }), { headers: { 'if-none-match': high.headers.etag } })
assert.equal(cached.statusCode, 304)
assert.equal(cached.body, undefined)
bundle = { ...bundle, revision: 'fixture-backfill' }
const revised = await invoke(query({ LAYERS: 'firms_viirs_snpp_high' }), { headers: { 'if-none-match': high.headers.etag } })
assert.equal(revised.statusCode, 200, 'A backfill must invalidate maps for an unchanged TIME')
assert.notEqual(revised.headers.etag, high.headers.etag)
const head = await invoke(query(), { method: 'HEAD' })
assert.equal(head.statusCode, 200)
assert.equal(head.body, undefined)
assert.ok(Number(head.headers['content-length']) > 0)
const opaque = await invoke(query({ LAYERS: 'firms_viirs_noaa21', TRANSPARENT: 'FALSE', BGCOLOR: '0x123456' }))
assert.deepEqual([...(await raw(opaque.body)).subarray(0, 4)], [0x12, 0x34, 0x56, 255])

// A wide-latitude two-colour image exposes a stretched-image error that small local crops hide.
const latitudeImage = await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]), { raw: { width: 1, height: 2, channels: 4 } }).png().toBuffer()
const projectedNorth = proj4('EPSG:4326', 'EPSG:3857', [1, 80])
const warpedRequest = { width: 10, height: 100, bbox: [0, 0, ...projectedNorth], crs: 'EPSG:3857' }
const warped = await raw(await reprojectRaster(latitudeImage, { bounds: [[0, 0], [80, 1]], crs: 'EPSG:4326', opacity: 1 }, warpedRequest))
const boundaryY = pixelPosition([40, 0.5], warpedRequest)[1]
assert.ok(boundaryY > 68 && boundaryY < 70)
assert.equal(warped[(60 * 10 + 5) * 4], 255, 'The 60% row is still north of 40 degrees after Mercator reprojection')
assert.equal(warped[(80 * 10 + 5) * 4 + 2], 255, 'The 80% row is south of 40 degrees')
const inverse = await raw(await reprojectRaster(latitudeImage, { bounds: [[0, 0], [80, 1]], crs: 'EPSG:3857', opacity: 1 }, { ...warpedRequest, crs: 'CRS:84', bbox: [0, 0, 1, 80] }))
assert.equal(inverse[(40 * 10 + 5) * 4 + 2], 255, 'RMI Mercator pixels must be reprojected back into geographic requests')
const parsed = mapRequest(wmsParameters(query({ CRS: 'EPSG:3857', BBOX: [0, 0, ...projectedNorth].join(',') })).parameters, layers, runtime)
assert.equal(parsed.crs, 'EPSG:3857')

// In-flight duplicates share work; a third distinct render receives a retryable error.
let release
const barrier = new Promise((resolve) => { release = resolve })
let blockedReads = 0
const limited = createWmsHandler({ getSnapshot: async () => bundle, loadImage: async () => { blockedReads += 1; await barrier; return red } })
const first = invoke(query({ LAYERS: 'precipitation' }), { target: limited })
const duplicate = invoke(query({ LAYERS: 'precipitation' }), { target: limited })
const second = invoke(query({ LAYERS: 'gibs_true_color' }), { target: limited })
for (let attempt = 0; blockedReads < 2 && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
assert.equal(blockedReads, 2)
const busy = await invoke(query({ LAYERS: 'gibs_false_color' }), { target: limited })
assert.equal(busy.statusCode, 503)
assert.equal(busy.headers['retry-after'], '1')
release()
const completed = await Promise.all([first, duplicate, second])
assert.ok(completed.every((result) => result.statusCode === 200))
assert.deepEqual(completed[0].body, completed[1].body)
const broken = createWmsHandler({ getSnapshot: async () => bundle, loadImage: async () => { throw new Error('Fixture missing artifact') } })
const unavailable = await invoke(query({ LAYERS: 'precipitation' }), { target: broken })
assert.equal(unavailable.statusCode, 503, 'A missing image is an error, not an empty observation')
assert.equal(unavailable.headers['cache-control'], 'no-store')

console.log(JSON.stringify({ layers: layers.length, imageReads: reads, axisOrder: 'passed', rasterReprojection: 'passed', historicalSelection: 'passed', cacheInvalidation: 'passed', concurrency: 'passed', preview: '/tmp/fire-wms-preview.png' }, null, 2))
