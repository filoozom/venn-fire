#!/usr/bin/env node

import assert from 'node:assert/strict'

import {
  flightDatabaseUrl,
  flightObservationKey,
  loadFlightHistory,
  mergeFlightHistory,
  persistFlightPoll,
} from '../server/flight-history.mjs'

function observation(icao24, observedAt, latitude, longitude, overrides = {}) {
  const identity = icao24 === '44c1e5'
    ? { callSign: 'G10', registration: 'OO-POE' }
    : { callSign: 'G17', registration: 'OO-POJ' }
  return {
    icao24,
    ...identity,
    observedAt,
    latitude,
    longitude,
    altitudeFt: null,
    groundSpeedKt: 75,
    trackDegrees: 210,
    distanceDrossartKm: 0.8,
    updateType: 'live receiver observation',
    providerId: 'adsb-fi',
    providerName: 'adsb.fi',
    providerUrl: 'https://adsb.fi/',
    corroboratedBy: [],
    ...overrides,
  }
}

function fakeDatabase() {
  const state = {
    observations: new Map(),
    runs: new Map(),
    schemaStatements: 0,
  }
  const query = async (text, parameters = []) => {
    if (/CREATE TABLE|CREATE INDEX/.test(text)) {
      state.schemaStatements += 1
      return []
    }
    if (text.includes('INSERT INTO flight_import_runs')) {
      state.runs.set(parameters[0], {
        bucketAt: parameters[0],
        polledAt: parameters[1],
        sources: JSON.parse(parameters[2]),
        conflicts: JSON.parse(parameters[3]),
        receivedObservationCount: parameters[4],
      })
      return []
    }
    if (text.includes('INSERT INTO flight_observations')) {
      const records = JSON.parse(parameters[0])
      records.forEach((record) => {
        state.observations.set(record.observation_key, {
          ...state.observations.get(record.observation_key),
          ...record,
        })
      })
      return records.map((record) => ({ observation_key: record.observation_key }))
    }
    if (text.includes('DELETE FROM flight_')) return []
    if (text.includes('FROM flight_observations')) {
      const [since, limit] = parameters
      return [...state.observations.values()]
        .filter((record) => Date.parse(record.observed_at) >= Date.parse(since))
        .sort((left, right) => Date.parse(left.observed_at) - Date.parse(right.observed_at))
        .slice(-limit)
    }
    throw new Error(`Unexpected SQL in verifier: ${text}`)
  }
  return { query, state }
}

assert.equal(flightDatabaseUrl({}), '')
assert.equal(flightDatabaseUrl({ POSTGRES_URL: ' postgres://fallback ' }), 'postgres://fallback')
assert.equal(flightDatabaseUrl({ DATABASE_URL: ' postgres://primary ', POSTGRES_URL: 'postgres://fallback' }), 'postgres://primary')

const unconfigured = await loadFlightHistory({ databaseUrl: '', query: null })
assert.deepEqual(unconfigured, { configured: false, ok: false, observations: [] })

const first = observation('44c1e5', '2026-08-15T12:00:00.000Z', 50.55, 6.06)
const duplicate = observation('44c1e5', '2026-08-15T12:00:00.000Z', 50.55, 6.06, {
  providerId: 'adsb-lol',
  providerName: 'ADSB.lol',
  providerUrl: 'https://www.adsb.lol/',
  corroboratedBy: ['adsb-fi'],
})
const second = observation('44c1ea', '2026-08-15T12:03:00.000Z', 50.56, 6.05)

assert.equal(flightObservationKey(first), flightObservationKey(duplicate))
const merged = mergeFlightHistory([first], [duplicate, second])
assert.equal(merged.length, 2)
assert.equal(merged[0].providerId, 'adsb-lol')
assert.deepEqual(merged[0].corroboratedBy, ['adsb-fi'])

const database = fakeDatabase()
const options = { databaseUrl: '', query: database.query }
const firstPoll = await persistFlightPoll({
  generatedAt: '2026-08-15T12:01:00.000Z',
  observations: [first],
  sources: [{ id: 'adsb-fi', ok: true }],
  conflicts: [],
}, options)
assert.equal(firstPoll.configured, true)
assert.equal(firstPoll.ok, true)
assert.equal(firstPoll.observations.length, 1)

const secondPoll = await persistFlightPoll({
  generatedAt: '2026-08-15T12:04:30.000Z',
  observations: [duplicate, second],
  sources: [{ id: 'adsb-lol', ok: true }],
  conflicts: [],
}, options)
assert.equal(secondPoll.bucketAt, '2026-08-15T12:00:00.000Z')
assert.equal(database.state.runs.size, 1, 'regional invocations in one five-minute bucket were not collapsed')
assert.equal(database.state.observations.size, 2, 'duplicate observations were not idempotent')
assert.equal(secondPoll.observations.length, 2)
assert.equal(database.state.schemaStatements, 3, 'schema was initialized more than once for one warm query client')
assert.equal(database.state.observations.get(flightObservationKey(first)).altitude_ft, null)

console.log('Verified: Postgres flight history is durable, bucketed and idempotent.')
