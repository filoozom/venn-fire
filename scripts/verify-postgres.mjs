#!/usr/bin/env node

import assert from 'node:assert/strict'

import { postgresEnvironmentKey, postgresPoolOptions, postgresUrl } from '../server/postgres.mjs'
import { PUBLIC_DATASET_KEYS, publicDatasetPayload } from '../server/public-datasets.mjs'

assert.equal(postgresUrl({}), '')
assert.equal(postgresUrl({ POSTGRES_URL: ' postgres://fallback ' }), 'postgres://fallback')
assert.equal(postgresUrl({
  DATABASE_URL: ' postgresql://primary ',
  POSTGRES_URL: 'postgres://fallback',
}), 'postgresql://primary')

const defaults = postgresPoolOptions('postgresql://example.test/fire', {})
assert.equal(defaults.max, 5)
assert.equal(defaults.connectionTimeoutMillis, 8_000)
assert.equal(defaults.idleTimeoutMillis, 5_000)
assert.equal(defaults.application_name, 'venn-fire-vercel')

const selfHostedEnvironment = {
  PGHOST: 'db.example.test',
  PGPORT: '41637',
  PGUSER: 'venn-fire',
  PGPASSWORD: 'test-only-password',
  PGDATABASE: 'venn-fire',
  PG_CA_PEM: '-----BEGIN CERTIFICATE-----\\nTEST\\n-----END CERTIFICATE-----',
  PGSSL_SERVERNAME: 'venn-fire-postgres',
  DATABASE_URL: 'postgresql://old-provider.invalid/fire',
}
const selfHostedKey = postgresEnvironmentKey(selfHostedEnvironment)
assert.equal(postgresUrl(selfHostedEnvironment), selfHostedKey)
assert(!selfHostedKey.includes(selfHostedEnvironment.PGPASSWORD))
const selfHosted = postgresPoolOptions(selfHostedKey, selfHostedEnvironment)
assert.equal(selfHosted.connectionString, undefined)
assert.equal(selfHosted.host, 'db.example.test')
assert.equal(selfHosted.port, 41_637)
assert.equal(selfHosted.user, 'venn-fire')
assert.equal(selfHosted.database, 'venn-fire')
assert.equal(selfHosted.ssl.servername, 'venn-fire-postgres')
assert.equal(selfHosted.ssl.rejectUnauthorized, true)
assert(selfHosted.ssl.ca.includes('\nTEST\n'))
assert.equal(selfHosted.enableChannelBinding, true)

assert.throws(
  () => postgresUrl({ PG_CA_PEM: 'certificate-only' }),
  /PGHOST is required/,
)

const configured = postgresPoolOptions('postgresql://example.test/fire', {
  DATABASE_POOL_MAX: '2',
  DATABASE_CONNECT_TIMEOUT_MS: '12000',
  DATABASE_IDLE_TIMEOUT_MS: '30000',
  DATABASE_MAX_LIFETIME_SECONDS: '600',
  DATABASE_APPLICATION_NAME: 'fire-test',
})
assert.equal(configured.max, 2)
assert.equal(configured.connectionTimeoutMillis, 12_000)
assert.equal(configured.idleTimeoutMillis, 30_000)
assert.equal(configured.maxLifetimeSeconds, 600)
assert.equal(configured.application_name, 'fire-test')

assert(PUBLIC_DATASET_KEYS.includes('aircraft'))
assert(PUBLIC_DATASET_KEYS.includes('firms'))
assert.equal(publicDatasetPayload('private-dataset', { secret: true }), null)

const publicAircraft = publicDatasetPayload('aircraft', {
  ok: true,
  sources: [{ id: 'adsb-lol' }],
  observations: [{
    icao24: '480849',
    callSign: 'GRZLY81',
    observedAt: '2026-08-15T12:00:00.000Z',
    latitude: 50.55,
    longitude: 6.06,
    altitudeFt: 2_100,
    updateType: 'receiver observation',
    providerUrl: 'https://adsb.lol/',
    providerName: 'repeated metadata',
    sourceData: { large: true },
  }],
})
assert.equal(publicAircraft.observations[0].providerName, undefined)
assert.equal(publicAircraft.observations[0].sourceData, undefined)
assert.equal(publicAircraft.observations[0].callSign, 'GRZLY81')

const publicFirms = publicDatasetPayload('firms', {
  sensors: [],
  detections: [{
    sensorKey: 'meteosat',
    acquiredAt: '2026-08-15T12:00:00.000Z',
    latitude: 50.55,
    longitude: 6.06,
    scanKm: 2.1,
    trackKm: 4.1,
    footprintBearingDeg: 187,
    confidence: { raw: 0.9, rank: 3, label: 'high' },
    footprint: [[50.5, 6.0]],
    footprintMethod: 'repeated verbose explanation',
    areaExclusionReason: 'repeated verbose explanation',
  }],
})
assert.equal(publicFirms.detections[0].footprint, undefined)
assert.equal(publicFirms.detections[0].footprintMethod, undefined)
assert.equal(publicFirms.detections[0].areaExclusionReason, undefined)
assert.equal(publicFirms.detections[0].footprintBearingDeg, 187)

console.log('Verified: generic PostgreSQL pooling and compact public database projections.')
