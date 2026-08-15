#!/usr/bin/env node

import assert from 'node:assert/strict'

import { LIVE_AIRCRAFT_PROVIDERS, normalizeAircraft } from '../api/live-situation.js'
import { payloadHash, setNoStoreHeaders } from '../server/database.mjs'
import {
  normalizeDatexRoadEvents,
  normalizeIncidentPerimeter,
  normalizePublicOperations,
} from '../server/controlled-sources.mjs'
import { normalizeVediaArticle } from '../server/media-sources.mjs'
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
  'vedia',
  'public-alerts',
  'road-events',
  'official-perimeter',
  'public-operations',
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
assert.equal(LIVE_AIRCRAFT_PROVIDERS.length, 3)
assert.equal(LIVE_AIRCRAFT_PROVIDERS.at(-1).id, 'airplanes-live')
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

const datexEvents = normalizeDatexRoadEvents(`
  <d2:situationRecord xmlns:d2="urn:datex" id="road-1" xsi:type="RoadOrCarriagewayOrLaneManagement">
    <d2:situationRecordCreationTime>2026-08-15T15:00:00Z</d2:situationRecordCreationTime>
    <d2:roadName>E42</d2:roadName>
    <d2:generalPublicComment><d2:value>Closed near Malmedy</d2:value></d2:generalPublicComment>
    <d2:locationForDisplay><d2:latitude>50.43</d2:latitude><d2:longitude>6.03</d2:longitude></d2:locationForDisplay>
  </d2:situationRecord>
`, '2026-08-15T15:05:00.000Z')
assert.equal(datexEvents.length, 1)
assert.equal(datexEvents[0].id, 'road-1')
assert.equal(datexEvents[0].roadName, 'E42')
assert.ok(datexEvents[0].distanceKmFromDrossart < 20)

const perimeter = normalizeIncidentPerimeter({
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { authority: 'fixture' },
    geometry: { type: 'Polygon', coordinates: [[[6.05, 50.54], [6.07, 50.54], [6.07, 50.56], [6.05, 50.54]]] },
  }],
})
assert.equal(perimeter.features.length, 1)

const operations = normalizePublicOperations({ events: [{
  id: 'drop-1',
  observedAt: '2026-08-15T15:00:00Z',
  type: 'water-drop',
  title: 'Published water-drop event',
  position: [50.55, 6.06],
}] }, '2026-08-15T15:05:00.000Z')
assert.equal(operations[0].type, 'water-drop')

const media = normalizeVediaArticle({
  id: 'fixture-article',
  attributes: {
    title: 'Incendie dans les Fagnes : fixture',
    created: '2026-08-15T14:00:00Z',
    changed: '2026-08-15T14:01:00Z',
    path: { alias: '/info/fixture/123' },
    field_content_main_content: { summary: 'Le feu progresse près de Drossart.', value: '<p>Incendie à Baelen.</p>' },
  },
}, '2026-08-15T14:05:00Z')
assert.equal(media.publisherKind, 'local-media')
assert.equal(media.url, 'https://www.vedia.be/info/fixture/123')
assert.equal(normalizeVediaArticle({
  id: 'unrelated-drought',
  attributes: {
    title: 'Sécheresse: nos rivières au plus bas',
    created: '2026-08-14T12:00:00Z',
    path: { alias: '/info/drought/124' },
    field_content_main_content: {
      summary: 'Les faibles pluies ne changeront pas la situation régionale.',
      value: '<p>Le risque d’incendie reste élevé dans le parc des Hautes Fagnes.</p>',
    },
  },
}, '2026-08-15T14:05:00Z'), null, 'body-only keyword overlap must not admit an unrelated article')

console.log('refresh pipeline verified: 14 leased sources, five-minute grid, public and controlled adapters, semantic history, no-store APIs')
