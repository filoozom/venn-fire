import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import sharp from 'sharp'
import proj4 from 'proj4'
import { createWmsHandler, retainedImage } from '../api/wms.js'
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
for (const [sourceKey, prefix] of [['nasa-gibs', 'nasa-gibs-image'], ['cams', 'cams-image'], ['rmi-radar', 'rmi-radar-image'], ['dwd-radar-history', 'dwd-radar-image']]) {
  const key = `${prefix}:fixture`
  const publicImage = { databaseUrl: `/api/source-image?id=${Buffer.from(key).toString('base64url')}` }
  const artifact = { sourceKey, contentEncoding: 'identity', contentType: 'image/png', originalSize: red.length, contentBase64: red.toString('base64') }
  const bytes = await retainedImage({ sourceKey, image: publicImage }, async (requestedKey) => {
    assert.equal(requestedKey, key, 'Compact public images must resolve their opaque ID to the stored artifact')
    return artifact
  })
  assert.deepEqual(bytes, red)
  await assert.rejects(retainedImage({ sourceKey, image: publicImage }, async () => null), /unavailable or invalid/u)
  await assert.rejects(retainedImage({ sourceKey, image: publicImage }, async () => ({ ...artifact, sourceKey: 'other' })), /unavailable or invalid/u)
}
await assert.rejects(retainedImage({ sourceKey: 'cams', image: { databaseUrl: '/api/source-image?id=invalid' } }), /Invalid retained image reference/u)
let reads = 0
const handler = createWmsHandler({ getSnapshot: async () => bundle, loadImage: async () => { reads += 1; return red } })

function response() {
  return Object.assign(new EventEmitter(), {
    headers: {}, statusCode: 200,
    setHeader(key, value) { this.headers[key.toLowerCase()] = String(value) },
    status(code) { this.statusCode = code; return this },
    end(body) { this.body = body; return this },
    destroy() { this.destroyed = true; this.emit('close') },
  })
}
const defaults = { SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap', LAYERS: 'firms_viirs_snpp', STYLES: '', TIME: time, CRS: 'CRS:84', BBOX: '6,50.5,6.1,50.6', WIDTH: '256', HEIGHT: '256', FORMAT: 'image/png', TRANSPARENT: 'TRUE' }
const query = (changes = {}) => `/wms?${new URLSearchParams({ ...defaults, ...changes })}`
async function invoke(url, { target = handler, method = 'GET', headers = {}, result = response() } = {}) {
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
assert.match(capabilitiesText, /<LayerLimit>64<\/LayerLimit>/u)
assert.match(capabilitiesText, /<CRS>EPSG:31370<\/CRS><CRS>EPSG:3812<\/CRS>/u)
for (const title of ['Fire extent and change', 'Thermal detections', 'Satellite imagery', 'Weather', 'Air quality models', 'Aircraft', 'Reference']) {
  assert.ok(capabilitiesText.includes(`<Layer><Title>${title}</Title>`), `Missing organizational group ${title}`)
}
assert.match(capabilitiesText, /<Title>Thermal detections<\/Title><Layer><Title>VIIRS Suomi-NPP<\/Title><Layer queryable="0" opaque="0"><Name>firms_viirs_snpp<\/Name><Title>All confidence levels<\/Title>/u)
const advertisedNames = [...capabilitiesText.matchAll(/<Name>([^<]+)<\/Name>/gu)]
  .map((match) => match[1]).filter((name) => !['WMS', 'default'].includes(name))
assert.deepEqual(advertisedNames.sort(), layers.map((layer) => layer.name).sort(), 'Groups must preserve every requestable layer exactly once')
assert.equal(new Set(layers.map((layer) => layer.name)).size, layers.length)
for (const name of ['best_estimate', 'aircraft', 'sentinel2_change', 'sentinel3_frp', 'precipitation', 'gibs_true_color', 'gibs_false_color', 'cams_pm25', 'cams_wildfire_pm10', 'wind_model', 'wind_mont_rigi', 'wind_dwd_123', 'protected_area', 'firms_viirs_noaa21_low', 'firms_modis_nominal', 'firms_meteosat_high']) {
  assert.ok(capabilitiesText.includes(`<Name>${name}</Name>`), `Missing layer ${name}`)
}
await writeFile('/tmp/fire-wms-capabilities.xml', capabilities.body)

const historicalCapabilities = await invoke(`/wms?SERVICE=WMS&REQUEST=GetCapabilities&TIME=${time}`)
assert.equal(historicalCapabilities.statusCode, 200)
const historicalText = historicalCapabilities.body.toString()
assert.ok(historicalText.includes(`default="${time}"`), 'A dated connection must advertise its selected default')
const mapUrl = new URL(historicalText.match(/<GetMap>.*?xlink:href="([^"]+)"/u)[1].replaceAll('&amp;', '&'))
assert.equal(mapUrl.searchParams.get('TIME'), time, 'Capabilities must preserve TIME for clients that discard the connection query')
for (const [key, value] of Object.entries(defaults)) if (key !== 'TIME') mapUrl.searchParams.set(key, value)
const historicalMap = await invoke(mapUrl.href)
assert.equal(historicalMap.statusCode, 200)
assert.equal(historicalMap.headers['x-wms-time'], time)
assert.ok(await visible(historicalMap.body))
assert.notEqual(historicalCapabilities.headers.etag, capabilities.headers.etag)

for (const [changes, code] of [
  [{ LAYERS: '<unknown>' }, 'LayerNotDefined'],
  [{ LAYERS: Array(65).fill('best_estimate').join(',') }, 'InvalidParameterValue'],
  [{ CRS: 'EPSG:99999' }, 'InvalidCRS'],
  [{ VERSION: '1.1.1' }, 'InvalidParameterValue'],
  [{ STYLES: 'remote' }, 'StyleNotDefined'],
  [{ FORMAT: 'image/jpeg' }, 'InvalidFormat'],
  [{ WIDTH: '99999' }, 'InvalidParameterValue'],
  [{ WIDTH: '2048', HEIGHT: '2049' }, 'InvalidParameterValue'],
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
  if (changes.TIME) {
    const invalidCapabilities = await invoke(`/wms?${new URLSearchParams({ SERVICE: 'WMS', REQUEST: 'GetCapabilities', TIME: changes.TIME })}`)
    assert.equal(invalidCapabilities.statusCode, 400, 'Capabilities must validate a selected date too')
    assert.match(String(invalidCapabilities.body), /code="InvalidDimensionValue"/u)
  }
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
// WalOnMap tiles large viewports at the advertised maximum width AND height.
const fullTile = await invoke(query({ LAYERS: 'firms_viirs_snpp_high', WIDTH: '2048', HEIGHT: '2048' }))
assert.equal(fullTile.statusCode, 200, String(fullTile.body).slice(0, 200))
const tileSize = await sharp(fullTile.body).metadata()
assert.equal(tileSize.width, 2048)
assert.equal(tileSize.height, 2048)
assert.ok(await visible(fullTile.body))
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
const allLayers = await invoke(query({ LAYERS: layers.map((layer) => layer.name).join(','), TIME: at(10) }))
assert.ok(layers.length > 32, 'The regression must cover selecting more than 32 advertised layers')
assert.equal(allLayers.statusCode, 200)
assert.ok(await visible(allLayers.body))

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

for (const crs of ['EPSG:31370', 'EPSG:3812']) {
  const center = proj4('EPSG:4326', crs, [6.05, 50.55])
  const bbox = [center[0] - 5000, center[1] - 5000, center[0] + 5000, center[1] + 5000]
  const request = { width: 100, height: 100, bbox, crs }
  const point = pixelPosition([50.55, 6.05], request)
  assert.ok(point.every((value) => Math.abs(value - 50) < 0.01), `${crs} marker must land at the map centre`)
  for (const name of ['firms_viirs_snpp_high', 'precipitation', layers.map((layer) => layer.name).join(',')]) {
    const result = await invoke(query({ LAYERS: name, CRS: crs, BBOX: bbox.join(',') }))
    assert.equal(result.statusCode, 200)
    assert.ok(await visible(result.body), `${crs} must render ${name}`)
  }
  // A broad checkerboard catches axis-separated warping that looks plausible in a local crop.
  const checker = await sharp(Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 0, 255,
  ]), { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer()
  const overlay = { bounds: [[49, 2], [52, 8]], crs: 'EPSG:4326', opacity: 1 }
  const emptyImage = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
  assert.equal(await visible(await reprojectRaster(emptyImage, overlay, request)), false, 'A dry radar image must stay transparent')
  const wide = { ...request, bbox: [center[0] - 220000, center[1] - 220000, center[0] + 220000, center[1] + 220000] }
  const pixels = await raw(await reprojectRaster(checker, overlay, wide))
  for (let y = 0; y < wide.height; y += 9) {
    for (let x = 0; x < wide.width; x += 9) {
      const [lon, lat] = proj4(crs, 'EPSG:4326', [wide.bbox[0] + (x + 0.5) * 4400, wide.bbox[3] - (y + 0.5) * 4400])
      const expected = lon < 2 || lon >= 8 || lat <= 49 || lat > 52 ? [0, 0, 0, 0]
        : lat > 50.5 ? lon < 5 ? [255, 0, 0, 255] : [0, 255, 0, 255]
          : lon < 5 ? [0, 0, 255, 255] : [255, 255, 0, 255]
      const offset = (y * wide.width + x) * 4
      assert.deepEqual([...pixels.subarray(offset, offset + 4)], expected, `${crs} raster pixel ${x},${y}`)
    }
  }
}

const abort = new AbortController()
const abortTimer = setTimeout(() => abort.abort(), 5)
await assert.rejects(reprojectRaster(red, { bounds, crs: 'EPSG:4326', opacity: 1 }, {
  width: 2048, height: 2048, crs: 'EPSG:3812', bbox: [760000, 630000, 780000, 650000],
}, {}, abort.signal), { name: 'AbortError' })
clearTimeout(abortTimer)

// Tile bursts queue behind two renders; duplicates share work and excess work is rejected.
let release
const barrier = new Promise((resolve) => { release = resolve })
let blockedReads = 0
const limited = createWmsHandler({ getSnapshot: async () => bundle, loadImage: async () => { blockedReads += 1; await barrier; return red } })
const first = invoke(query({ LAYERS: 'precipitation' }), { target: limited })
const duplicate = invoke(query({ LAYERS: 'precipitation' }), { target: limited })
const second = invoke(query({ LAYERS: 'gibs_true_color' }), { target: limited })
for (let attempt = 0; blockedReads < 2 && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
assert.equal(blockedReads, 2)
const queued = Array.from({ length: 6 }, (_, index) => invoke(query({ LAYERS: 'gibs_false_color', WIDTH: String(256 + index) }), { target: limited }))
const queuedDuplicate = invoke(query({ LAYERS: 'gibs_false_color' }), { target: limited })
const busy = await invoke(query({ LAYERS: 'gibs_false_color', WIDTH: '262' }), { target: limited })
assert.equal(busy.statusCode, 503)
assert.equal(busy.headers['retry-after'], '1')
assert.equal(blockedReads, 2, 'Queued maps must not start rendering before a slot is released')
release()
const completed = await Promise.all([first, duplicate, second, ...queued, queuedDuplicate])
assert.ok(completed.every((result) => result.statusCode === 200))
assert.deepEqual(completed[0].body, completed[1].body)
assert.equal(blockedReads, 8, 'Duplicates must share queued renders as well as active renders')

let releaseCancellation, cancellationReads = 0
const cancellationGate = new Promise((resolve) => { releaseCancellation = resolve })
const cancellable = createWmsHandler({ getSnapshot: async () => bundle, loadImage: async () => { cancellationReads += 1; await cancellationGate; return red } })
const activeResponse = response(), duplicateResponse = response(), cancelledActive = response()
const activeWork = invoke(query({ LAYERS: 'precipitation' }), { target: cancellable, result: activeResponse })
const duplicateWork = invoke(query({ LAYERS: 'precipitation' }), { target: cancellable, result: duplicateResponse })
const cancelledActiveWork = invoke(query({ LAYERS: 'gibs_true_color' }), { target: cancellable, result: cancelledActive })
for (let attempt = 0; cancellationReads < 2 && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
assert.equal(cancellationReads, 2)
const abandoned = Array.from({ length: 6 }, () => response())
const abandonedWork = abandoned.map((result, index) => invoke(query({ LAYERS: 'gibs_false_color', WIDTH: String(256 + index) }), { target: cancellable, result }))
const survivingQueued = response()
const survivingWork = invoke(query({ LAYERS: 'gibs_false_color' }), { target: cancellable, result: survivingQueued })
assert.equal((await invoke(query({ LAYERS: 'gibs_false_color', WIDTH: '262' }), { target: cancellable })).statusCode, 503)
activeResponse.destroy()
cancelledActive.destroy()
abandoned.forEach((result) => result.destroy())
const replacement = invoke(query({ LAYERS: 'gibs_false_color', WIDTH: '262' }), { target: cancellable })
releaseCancellation()
const cancelledResults = await Promise.all([activeWork, duplicateWork, cancelledActiveWork, ...abandonedWork, survivingWork, replacement])
assert.equal(cancellationReads, 4, 'Abandoned queued tiles must not load images; surviving duplicates must still render')
assert.equal(duplicateResponse.headers['content-type'], 'image/png')
assert.equal(survivingQueued.headers['content-type'], 'image/png')
assert.equal(cancelledResults.at(-1).headers['content-type'], 'image/png', 'Cancelling queued tiles must free capacity for a replacement')
for (const result of [activeResponse, cancelledActive, ...abandoned]) assert.equal(result.body, undefined)
for (const result of cancelledResults) assert.equal(result.listenerCount('close'), 0)
const broken = createWmsHandler({ getSnapshot: async () => bundle, loadImage: async () => { throw new Error('Fixture missing artifact') } })
const unavailable = await invoke(query({ LAYERS: 'precipitation' }), { target: broken })
assert.equal(unavailable.statusCode, 503, 'A missing image is an error, not an empty observation')
assert.equal(unavailable.headers['cache-control'], 'no-store')

console.log(JSON.stringify({ layers: layers.length, imageReads: reads, axisOrder: 'passed', rasterReprojection: 'passed', historicalSelection: 'passed', cacheInvalidation: 'passed', concurrency: 'passed', preview: '/tmp/fire-wms-preview.png' }, null, 2))
