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
assert(PUBLIC_DATASET_KEYS.includes('rmi-radar'))
assert(PUBLIC_DATASET_KEYS.includes('nasa-gibs'))
assert(PUBLIC_DATASET_KEYS.includes('cams'))
assert(PUBLIC_DATASET_KEYS.includes('sentinel1'))
assert(PUBLIC_DATASET_KEYS.includes('sentinel3-frp'))
assert(!PUBLIC_DATASET_KEYS.includes('road-events'))
assert(!PUBLIC_DATASET_KEYS.includes('official-perimeter'))
assert(!PUBLIC_DATASET_KEYS.includes('public-operations'))
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
    routeScope: 'full-route',
    providerUrl: 'https://adsb.lol/',
    providerName: 'repeated metadata',
    sourceData: { large: true },
  }],
})
assert.equal(publicAircraft.observations[0].providerName, undefined)
assert.equal(publicAircraft.observations[0].sourceData, undefined)
assert.equal(publicAircraft.observations[0].callSign, 'GRZLY81')
assert.equal(publicAircraft.observations[0].routeScope, 'full-route')

const publicSourceRegistry = publicDatasetPayload('source-registry', {
  sources: [
    { key: 'reports', access: { kind: 'public', configured: true } },
    { key: 'aircraft-history', directory: false },
    { key: 'road-events', access: { kind: 'controlled', configured: false } },
  ],
  coverageGaps: [{ key: 'internal-source-limit' }],
})
assert.deepEqual(publicSourceRegistry.sources, [{ key: 'reports' }])
assert.equal(publicSourceRegistry.coverageGaps, undefined)

const publicSentinel = publicDatasetPayload('sentinel2', {
  scenes: [{
    name: 'scene',
    quicklook: {
      stored: true,
      databaseUrl: '/api/sentinel-quicklook?id=public-id',
      artifactKey: 'internal-artifact-key',
      sha256: 'internal-sha',
    },
  }],
  analyses: [{
    status: 'ready',
    supportCells: [[1, 2]],
    geometry: { type: 'MultiPolygon', coordinates: [] },
    sourceRasterArtifactKey: 'internal-raster-artifact-key',
  }],
})
assert.equal(publicSentinel.scenes[0].quicklook.artifactKey, undefined)
assert.equal(publicSentinel.scenes[0].quicklook.sha256, undefined)
assert.equal(publicSentinel.scenes[0].quicklook.databaseUrl, '/api/sentinel-quicklook?id=public-id')
assert.equal(publicSentinel.analyses[0].sourceRasterArtifactKey, undefined)
assert.deepEqual(publicSentinel.analyses[0].supportCells, [[1, 2]])

const publicEnvironmental = publicDatasetPayload('cams', {
  frames: [{
    productKey: 'wildfire-pm10',
    validAt: '2026-08-17T17:00:00Z',
    point: { value: 1.88, unit: 'µg/m³' },
    valueArtifactKey: 'private-value-artifact',
    image: {
      artifactKey: 'private-image-artifact',
      sha256: 'private-hash',
      databaseUrl: '/api/source-image?id=opaque',
      contentType: 'image/png',
      byteLength: 12_000,
    },
  }],
})
assert.equal(publicEnvironmental.frames[0].valueArtifactKey, undefined)
assert.equal(publicEnvironmental.frames[0].image.artifactKey, undefined)
assert.equal(publicEnvironmental.frames[0].image.sha256, undefined)
assert.equal(publicEnvironmental.frames[0].image.databaseUrl, '/api/source-image?id=opaque')

const publicSentinel1 = publicDatasetPayload('sentinel1', {
  scenes: [{
    id: 'scene',
    thumbnailProviderUrl: 'https://provider.invalid/private-detail',
    thumbnail: {
      stored: false,
      providerUrl: 'https://provider.invalid/preview',
      error: 'private upstream error',
    },
  }],
})
assert.equal(publicSentinel1.scenes[0].thumbnailProviderUrl, undefined)
assert.equal(publicSentinel1.scenes[0].thumbnail.error, undefined)
assert.equal(publicSentinel1.scenes[0].thumbnail.providerUrl, 'https://provider.invalid/preview')

const aircraftWithoutOovst = publicDatasetPayload('aircraft', {
  observations: [{
    icao24: '44da74',
    callSign: 'OOVST',
    observedAt: '2026-08-16T12:00:00.000Z',
    latitude: 50.55,
    longitude: 6.06,
  }, {
    icao24: '06a30b',
    callSign: 'QTR8098',
    observedAt: '2026-08-17T14:26:54.467Z',
    latitude: 50.51,
    longitude: 6.01,
  }],
  latestObservations: [],
})
assert.equal(aircraftWithoutOovst.observations.length, 0)

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
