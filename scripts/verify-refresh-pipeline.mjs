#!/usr/bin/env node

import assert from 'node:assert/strict'

import { LIVE_AIRCRAFT_PROVIDERS, normalizeAircraft } from '../api/live-situation.js'
import { payloadHash, setNoStoreHeaders } from '../server/database.mjs'
import { REFRESH_SOURCES } from '../server/refresh-sources.mjs'
import {
  nextRefreshWakeAt,
  REFRESH_INTERVAL_MS,
  REFRESH_OFFSET_MS,
  REFRESH_QUEUE_TOPIC,
  REFRESH_SCHEDULER_DATASET,
  refreshSchedulerDeployment,
} from '../server/refresh-scheduler.mjs'

const expectedSources = [
  'aircraft',
  'open-meteo',
  'reports',
  'public-alerts',
  'rmi',
  'dwd',
  'firms',
  'effis',
  'ems',
  'sentinel2',
]
assert.deepEqual(REFRESH_SOURCES.map((source) => source.key), expectedSources)
assert.ok(REFRESH_SOURCES.every((source) => source.intervalMinutes >= 5))
assert.ok(REFRESH_SOURCES.every((source) => source.intervalMinutes % 5 === 0))
assert.equal(REFRESH_SOURCES.find((source) => source.key === 'aircraft').intervalMinutes, 5)
assert.equal(REFRESH_SOURCES.find((source) => source.key === 'firms').intervalMinutes, 15)
assert.equal(REFRESH_QUEUE_TOPIC, 'venn-fire-refresh')
assert.equal(REFRESH_SCHEDULER_DATASET, 'refresh-scheduler')
assert.equal(REFRESH_INTERVAL_MS, 5 * 60_000)
assert.equal(REFRESH_OFFSET_MS, 2 * 60_000)
assert.deepEqual(refreshSchedulerDeployment({
  VERCEL_DEPLOYMENT_ID: 'dpl_test',
  VERCEL_GIT_COMMIT_SHA: 'abc123',
}), { deploymentId: 'dpl_test', gitCommitSha: 'abc123' })
assert.throws(() => refreshSchedulerDeployment({}), /VERCEL_DEPLOYMENT_ID/)
assert.equal(
  new Date(nextRefreshWakeAt(Date.parse('2026-08-15T14:19:39.000Z'))).toISOString(),
  '2026-08-15T14:22:00.000Z',
)
assert.equal(
  new Date(nextRefreshWakeAt(Date.parse('2026-08-15T14:22:00.000Z'))).toISOString(),
  '2026-08-15T14:27:00.000Z',
)

const provider = LIVE_AIRCRAFT_PROVIDERS[0]
const normalized = normalizeAircraft({
  now: 1_786_781_100,
  ac: [
    { hex: '44c1e5', flight: 'G10 ', lat: 50.55, lon: 6.06, seen_pos: 10, alt_baro: 1_500 },
    { hex: '44c1e8', flight: 'G12 ', lat: 50.80, lon: 6.50, seen_pos: 1, alt_baro: 1_000 },
    { hex: 'deadbe', flight: 'OTHER', lat: 50.55, lon: 6.06, seen_pos: 1, alt_baro: 2_000 },
  ],
}, provider, Date.parse('2026-08-15T12:05:01Z'))
assert.equal(normalized.length, 1, 'aircraft normalization must enforce identity and incident-radius filters')
assert.equal(normalized[0].observedAt, '2026-08-15T08:04:50.000Z')

const earlier = {
  generatedAt: '2026-08-15T13:00:00.000Z',
  alerts: [{ id: 'one', lastRetrievedAt: '2026-08-15T13:00:00.000Z' }],
}
const later = {
  generatedAt: '2026-08-15T13:05:00.000Z',
  alerts: [{ id: 'one', lastRetrievedAt: '2026-08-15T13:05:00.000Z' }],
}
assert.equal(payloadHash(earlier), payloadHash(later), 'retrieval timestamps must not create fake versions')
later.alerts[0].id = 'two'
assert.notEqual(payloadHash(earlier), payloadHash(later), 'semantic source changes must create a version')

const headers = new Map()
setNoStoreHeaders({ setHeader: (key, value) => headers.set(key, value) })
assert.equal(headers.get('Cache-Control'), 'no-store, max-age=0')
assert.equal(headers.get('CDN-Cache-Control'), 'no-store')
assert.equal(headers.get('Vercel-CDN-Cache-Control'), 'no-store')

console.log('refresh pipeline verified: 10 leased sources, five-minute grid, semantic history, no-store APIs')
