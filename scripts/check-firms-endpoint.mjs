#!/usr/bin/env node

// Offline contract check for /api/firms-situation. It uses a synthetic FIRMS
// response and a placeholder key; it never contacts NASA or needs a real key.

import assert from 'node:assert/strict'

import handler from '../api/firms-situation.js'

function responseRecorder() {
  const state = { headers: {}, statusCode: null, body: null }
  return {
    state,
    setHeader(name, value) { state.headers[name.toLowerCase()] = value },
    status(code) {
      state.statusCode = code
      return {
        json(value) { state.body = value; return state },
        end() { return state },
      }
    },
  }
}

async function invoke() {
  const response = responseRecorder()
  await handler({ method: 'GET' }, response)
  return response.state
}

const originalFetch = globalThis.fetch
const originalKey = process.env.FIRMS_MAP_KEY

try {
  delete process.env.FIRMS_MAP_KEY
  let fetchCount = 0
  globalThis.fetch = async () => {
    fetchCount += 1
    throw new Error('The unconfigured route must not fetch')
  }
  const unconfigured = await invoke()
  assert.equal(unconfigured.statusCode, 200)
  assert.equal(unconfigured.body.ok, false)
  assert.equal(unconfigured.body.configured, false)
  assert.equal(fetchCount, 0)
  assert.match(unconfigured.headers['cache-control'], /s-maxage=900/)

  process.env.FIRMS_MAP_KEY = 'TEST_ONLY_KEY'
  const requestedUrls = []
  const viirsFixture = [
    'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight',
    '50.54762,6.05757,340.1,0.375,0.375,2026-08-15,0900,N,VIIRS,n,2.0NRT,295.3,12.4,D',
    // Parsed but removed by the hard 15 km radius filter.
    '50.75000,6.40000,350.0,0.375,0.375,2026-08-15,0900,N,VIIRS,h,2.0NRT,299.0,30.0,D',
  ].join('\n')
  const modisFixture = [
    'latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight',
    '50.54762,6.05757,340.1,1.0,1.0,2026-08-15,0900,Terra,MODIS,85,6.1NRT,295.3,12.4,D',
    '50.75000,6.40000,350.0,1.0,1.0,2026-08-15,0900,Terra,MODIS,90,6.1NRT,299.0,30.0,D',
  ].join('\n')
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url))
    return {
      ok: true,
      status: 200,
      async text() { return String(url).includes('/MODIS_NRT/') ? modisFixture : viirsFixture },
    }
  }

  const configured = await invoke()
  assert.equal(configured.statusCode, 200)
  assert.equal(configured.body.ok, true)
  assert.equal(configured.body.configured, true)
  assert.equal(configured.body.sensors.length, 4)
  assert.equal(configured.body.detections.length, 4)
  assert.ok(configured.body.sensors.every((sensor) => sensor.excludedOutsideRadius === 1))
  assert.ok(configured.body.detections.every((detection) => detection.meetsMinimumConfidence))
  assert.equal(requestedUrls.length, 4)
  assert.ok(requestedUrls.every((url) => url.includes('TEST_ONLY_KEY')))

  const serialized = JSON.stringify(configured.body)
  assert.equal(serialized.includes('TEST_ONLY_KEY'), false)
  assert.ok(configured.body.sensors.every(
    (sensor) => sensor.sourceRequestUrl.includes('/MAP_KEY/'),
  ))
  assert.ok(configured.body.interpretation.some((line) => line.includes('MODIS')))

  console.log('FIRMS endpoint contract passed: optional key, four sensors, 15 km filter, key redaction and 15-minute cache.')
} finally {
  globalThis.fetch = originalFetch
  if (originalKey == null) delete process.env.FIRMS_MAP_KEY
  else process.env.FIRMS_MAP_KEY = originalKey
}
