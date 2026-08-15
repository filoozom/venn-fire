#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { gunzip as gunzipCallback } from 'node:zlib'

import { LIVE_AIRCRAFT_PROVIDERS, normalizeAircraft } from '../api/live-situation.js'
import {
  FLIGHT_IMPORT_INTERVAL_MINUTES,
  importLiveFlights,
} from './import-live-flights.mjs'
import { MINUTE, SOURCES } from './refresh-daemon.mjs'

const gunzip = promisify(gunzipCallback)

const flightSource = SOURCES.find((source) => source.key === 'flights')
assert.ok(flightSource, 'refresh daemon has no flights source')
assert.equal(flightSource.intervalMs, 5 * MINUTE, 'flight refresh is not scheduled every five minutes')
assert.equal(flightSource.retryIntervalMs, 5 * MINUTE, 'failed flight imports must retry after five minutes')
assert.deepEqual(flightSource.command, ['scripts/import-live-flights.mjs'])
assert.equal(FLIGHT_IMPORT_INTERVAL_MINUTES, 5)

const provider = LIVE_AIRCRAFT_PROVIDERS[0]
const normalized = normalizeAircraft({
  now: 1_786_781_100,
  ac: [
    { hex: '44c1e5', flight: 'G10 ', lat: 50.55, lon: 6.06, seen_pos: 10, alt_baro: 1_500 },
    { hex: '44c1e8', flight: 'G12 ', lat: 50.80, lon: 6.50, seen_pos: 1, alt_baro: 1_000 },
    { hex: 'deadbe', flight: 'OTHER', lat: 50.55, lon: 6.06, seen_pos: 1, alt_baro: 2_000 },
  ],
}, provider, Date.parse('2026-08-15T12:05:01Z'))
assert.equal(normalized.length, 1, 'normalization did not enforce the identifier and 10 km filters')
assert.equal(normalized[0].observedAt, '2026-08-15T08:04:50.000Z', 'provider epoch was not used for the observation time')

function observation(icao24, observedAt, latitude, longitude, overrides = {}) {
  const identities = {
    '44c1e5': { callSign: 'G10', registration: 'OO-POE' },
    '44c1ea': { callSign: 'G17', registration: 'OO-POJ' },
  }
  return {
    icao24,
    ...identities[icao24],
    observedAt,
    latitude,
    longitude,
    altitudeFt: 1_400,
    groundSpeedKt: 82,
    trackDegrees: 240,
    seenPositionSeconds: 2,
    distanceDrossartKm: 0.5,
    updateType: 'adsb.fi live receiver observation',
    providerId: 'adsb-fi',
    providerName: 'adsb.fi',
    providerUrl: 'https://adsb.fi/',
    corroboratedBy: [],
    ...overrides,
  }
}

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'venn-flight-refresh-'))

try {
  const firstObservation = observation('44c1e5', '2026-08-15T12:00:00.000Z', 50.55, 6.06)
  const secondObservation = observation('44c1ea', '2026-08-15T12:05:00.000Z', 50.56, 6.05)
  let poll = 0
  const load = async (_requestedAtMs, providers, options) => {
    assert.equal(options.includeRaw, true)
    poll += 1
    return {
      observations: poll === 1 ? [firstObservation] : [firstObservation, secondObservation],
      conflicts: [],
      sources: providers.map(({ id, name }) => ({ id, name, ok: true })),
      rawResponses: providers.map((currentProvider) => {
        const payload = { now: poll, ac: [{ hex: poll === 1 ? '44c1e5' : '44c1ea' }] }
        return { provider: currentProvider, payload, rawBody: JSON.stringify(payload) }
      }),
    }
  }
  const options = {
    output: temporaryDirectory,
    retentionDays: 30,
    adsbFiUrl: '',
    adsbLolUrl: '',
  }

  const first = await importLiveFlights(options, load, Date.parse('2026-08-15T12:00:05Z'))
  assert.equal(first.importedObservations, 1)
  assert.equal(first.retainedObservations, 1)

  const second = await importLiveFlights(options, load, Date.parse('2026-08-15T12:05:05Z'))
  assert.equal(second.importedObservations, 1, 'a duplicate was imported a second time')
  assert.equal(second.duplicateObservations, 1)
  assert.equal(second.retainedObservations, 2, 'the prior observation was replaced instead of retained')

  const snapshot = JSON.parse(await readFile(path.join(temporaryDirectory, 'observations.json'), 'utf8'))
  assert.equal(snapshot.importIntervalMinutes, 5)
  assert.deepEqual(snapshot.observations.map((item) => item.icao24), ['44c1e5', '44c1ea'])

  const geoJson = JSON.parse(await readFile(path.join(temporaryDirectory, 'observations.geojson'), 'utf8'))
  assert.equal(geoJson.features.length, 2)
  const csv = await readFile(path.join(temporaryDirectory, 'observations.csv'), 'utf8')
  assert.equal(csv.trim().split('\n').length, 3)

  const manifest = JSON.parse(await readFile(path.join(temporaryDirectory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.cadence.intervalMinutes, 5)
  assert.equal(manifest.poll.importedObservations, 1)
  assert.equal(manifest.poll.duplicateObservations, 1)
  assert.equal(manifest.poll.rawFiles.length, 2)

  const rawPath = path.join(temporaryDirectory, manifest.poll.rawFiles[0])
  const rawPayload = JSON.parse((await gunzip(await readFile(rawPath))).toString('utf8'))
  assert.equal(rawPayload.now, 2, 'compressed provider response was not retained exactly')
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}

console.log('Verified: new exact flight observations are retained without duplicates on a five-minute schedule.')
