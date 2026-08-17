#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import butgenbachSourceHandler, { config as butgenbachSourceConfig } from '../api/butgenbach-source.js'
import { loadFirms } from '../api/firms-situation.js'
import {
  INCIDENT_AIRCRAFT,
  LIVE_AIRCRAFT_PROVIDERS,
  normalizeAircraft,
  promoteIncidentAircraftCandidates,
  resolveIncidentAircraft,
} from '../api/live-situation.js'
import {
  CURRENT_AIRCRAFT_TRACE_PROVIDERS,
  HISTORICAL_AIRCRAFT_TRACE_PROVIDERS,
  normalizeAircraftTrace,
  recoverAircraftArtifactObservations,
  trackedAircraftFromObservations,
} from '../server/aircraft-sources.mjs'
import { buildProviderArtifact } from '../server/source-artifacts.mjs'
import { parseLegacyEffisSource } from '../server/effis-sources.mjs'
import { parseLegacyReportSource } from '../server/report-sources.mjs'
import { payloadHash, setNoStoreHeaders } from '../server/database.mjs'
import {
  normalizeDatexRoadEvents,
  normalizeIncidentPerimeter,
  normalizePublicOperations,
} from '../server/controlled-sources.mjs'
import { normalizeVediaArticle } from '../server/media-sources.mjs'
import {
  MUNICIPAL_PROVIDERS,
  municipalNoticeEvent,
  normalizeButgenbachNotice,
  normalizeHlzNotice,
  normalizeRdfNotice,
  normalizeWaimesNotice,
  normalizeWordpressApiNotice,
  parseButgenbachSitemap,
  parseMunicipalRdfFeed,
  parseHlzNewsList,
} from '../server/municipal-sources.mjs'
import {
  completedUtcDatesBeforeToday,
  firmsDetectionKey,
  REFRESH_SOURCES,
  routeRecoveryTargets,
} from '../server/refresh-sources.mjs'
import { aircraftObservationEvents, buildEvents, mergeIncidentFlights } from '../src/data.js'
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
  'aircraft-artifacts',
  'aircraft-traces',
  'aircraft-history',
  'aircraft-route-history',
  'open-meteo',
  'reports',
  'local-authority-updates',
  'vedia',
  'public-alerts',
  'road-events',
  'official-perimeter',
  'public-operations',
  'rmi',
  'dwd',
  'firms',
  'firms-history',
  'effis',
  'effis-history-migration',
  'ems',
  'sentinel2',
]

const legacyReports = parseLegacyReportSource(`
export const areaReports = [
  {
    timestampMs: Date.parse('2026-08-14T16:00:00+02:00'),
    reportedHa: 60,
    areaPrefix: '~',
    areaLabel: 'official estimate at 16:00 CEST',
    source: 'Governor of Liège',
    sourceUrl: 'https://gouverneur.provincedeliege.be/fr/node/7923',
  },
  {
    timestampMs: Date.parse('2026-08-14T20:00:00+02:00'),
    reportedHa: 100,
    areaPrefix: '~',
    areaLabel: 'official estimate at 20:00 CEST',
    source: 'Governor of Liège',
    sourceUrl: 'https://gouverneur.provincedeliege.be/fr/node/7923',
  },
  {
    timestampMs: Date.parse('2026-08-15T07:00:00+02:00'),
    reportedHa: 850,
    areaPrefix: '~',
    areaLabel: 'official estimate at 07:00 CEST',
    source: 'Governor of Liège',
    sourceUrl: 'https://gouverneur.provincedeliege.be/fr/node/7923',
  },
  {
    timestampMs: Date.parse('2026-08-15T11:28:00+02:00'),
    reportedHa: 900,
    areaPrefix: '>',
    areaLabel: 'local reporting updated at 11:28 CEST',
    source: 'BRF',
    sourceUrl: 'https://brf.be/regional/2100196/',
  },
  {
    timestampMs: Date.parse('2026-08-15T14:30:00+02:00'),
    reportedHa: 1500,
    areaPrefix: '>',
    areaLabel: 'BRF update at 14:30 CEST',
    source: 'BRF',
    sourceUrl: 'https://brf.be/regional/2100196/',
  },
]

export function mergeAreaReports() {}
`)
assert.deepEqual(legacyReports.map((report) => report.reportedHa), [60, 100, 850, 900, 1500])
const legacyEffisProducts = parseLegacyEffisSource(`
const effisBurnedArea20260814 = {
  productDate: '2026-08-14', source: 'Copernicus EFFIS', areaHa: 501.4,
  rings: [[[50.5, 6.0], [50.5, 6.1], [50.6, 6.1], [50.5, 6.0]]],
}
const effisBurnedArea20260815 = {
  productDate: '2026-08-15', source: 'Copernicus EFFIS', areaHa: 4857,
  rings: [[[50.4, 5.9], [50.4, 6.2], [50.7, 6.2], [50.4, 5.9]]],
}
export const effisBurnedAreas = [effisBurnedArea20260814, effisBurnedArea20260815]
`)
assert.deepEqual(legacyEffisProducts.map((product) => product.areaHa), [501.4, 4857])
assert.deepEqual(REFRESH_SOURCES.map((source) => source.key), expectedSources)
assert.ok(REFRESH_SOURCES.every((source) => source.intervalMinutes >= 5))
assert.ok(REFRESH_SOURCES.every((source) => source.intervalMinutes % 5 === 0))
assert.equal(REFRESH_SOURCES.find((source) => source.key === 'aircraft').intervalMinutes, 5)
assert.equal(REFRESH_SOURCES.find((source) => source.key === 'aircraft-traces').intervalMinutes, 5)
assert.equal(REFRESH_SOURCES.find((source) => source.key === 'aircraft-history').intervalMinutes, 360)
assert.equal(REFRESH_SOURCES.find((source) => source.key === 'aircraft-route-history').intervalMinutes, 5)
assert.equal(REFRESH_SOURCES.find((source) => source.key === 'firms').intervalMinutes, 15)
assert.equal(REFRESH_SOURCES.find((source) => source.key === 'sentinel2').intervalMinutes, 5)
assert.deepEqual(completedUtcDatesBeforeToday(Date.parse('2026-08-17T12:00:00.000Z')), [
  '2026-08-16',
  '2026-08-15',
  '2026-08-14',
])
assert.equal(LIVE_AIRCRAFT_PROVIDERS.length, 3)
assert.equal(LIVE_AIRCRAFT_PROVIDERS.at(-1).id, 'airplanes-live')
assert.equal(LIVE_AIRCRAFT_PROVIDERS.at(-1).intervalMinutes, 60)
assert.ok(LIVE_AIRCRAFT_PROVIDERS.find((provider) => provider.id === 'adsb-fi').endpoint
  .includes('/v3/lat/50.54762/lon/6.05757/dist/10'))
assert.ok(LIVE_AIRCRAFT_PROVIDERS.filter((provider) => provider.id !== 'adsb-fi')
  .every((provider) => provider.endpoint.includes('/point/50.54762/6.05757/10')))
assert.equal(INCIDENT_AIRCRAFT.get('480849').registration, 'D-472')
assert.equal(INCIDENT_AIRCRAFT.get('48044a').registration, 'D-604')
assert.deepEqual(INCIDENT_AIRCRAFT.get('480440'), {
  callSign: 'GRZLY81',
  registration: 'D-479',
  aircraftType: 'H47',
  aircraftDescription: 'Boeing CH-47F Chinook',
  displayType: 'helicopter',
})
assert.deepEqual(INCIDENT_AIRCRAFT.get('48044c'), {
  callSign: 'GRZLY80',
  registration: 'D-606',
  aircraftType: 'H47',
  aircraftDescription: 'Boeing CH-47F Chinook',
  displayType: 'helicopter',
})
assert.deepEqual(INCIDENT_AIRCRAFT.get('480444'), {
  callSign: 'GRZLY80',
  registration: 'D-483',
  aircraftType: 'H47',
  aircraftDescription: 'Boeing CH-47F Chinook',
  displayType: 'helicopter',
})
assert.equal(CURRENT_AIRCRAFT_TRACE_PROVIDERS.length, 1)
assert.equal(HISTORICAL_AIRCRAFT_TRACE_PROVIDERS.length, 2)
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
    { hex: '480999', flight: 'GRZLY82 ', r: 'D-999', t: 'H47', lat: 50.55, lon: 6.06, seen_pos: 4, alt_baro: 2_200 },
    { hex: '480849', r: 'D-472', t: 'H47', lat: 50.56, lon: 6.05, seen_pos: 3, alt_baro: 2_300 },
  ],
}, provider, Date.parse('2026-08-15T12:05:01Z'))
assert.equal(normalized.length, 3, 'aircraft normalization must retain verified/dynamic incident aircraft and reject unrelated traffic')
assert.equal(normalized[0].observedAt, '2026-08-15T08:04:50.000Z')
assert.equal(normalized[1].selectionBasis, 'incident-callsign')
assert.equal(normalized[1].registration, 'D-999')
assert.equal(normalized[2].registration, 'D-472')

const responseCandidate = normalizeAircraft({
  now: 1_786_781_100,
  ac: [{
    hex: '4bffff',
    flight: 'SWED01 ',
    r: 'SE-MAA',
    t: 'AT8T',
    category: 'A1',
    lat: 50.55,
    lon: 6.06,
    seen_pos: 2,
    alt_baro: 3_200,
    gs: 145,
  }],
}, provider, Date.parse('2026-08-15T12:05:01Z'), INCIDENT_AIRCRAFT, { includeCandidates: true })
assert.equal(responseCandidate.length, 1, 'a low-altitude fire-response aircraft type must enter candidate evaluation')
const promotedResponseCandidate = promoteIncidentAircraftCandidates(responseCandidate)
assert.equal(promotedResponseCandidate.length, 1)
assert.equal(promotedResponseCandidate[0].selectionBasis, 'incident-response-type')
assert.equal(promotedResponseCandidate[0].displayType, 'plane')

const genericCandidatePayload = {
  now: 1_786_781_100,
  ac: [{
    hex: '4bfffe',
    flight: 'UNKNOWN ',
    t: 'C172',
    category: 'A1',
    lat: 50.551,
    lon: 6.061,
    seen_pos: 3,
    alt_baro: 3_500,
    gs: 90,
  }],
}
const genericFromFi = normalizeAircraft(
  genericCandidatePayload,
  LIVE_AIRCRAFT_PROVIDERS[0],
  Date.parse('2026-08-15T12:05:01Z'),
  INCIDENT_AIRCRAFT,
  { includeCandidates: true },
)
assert.equal(promoteIncidentAircraftCandidates(genericFromFi).length, 0, 'one generic low-altitude row must not be promoted alone')
const genericFromLol = normalizeAircraft(
  genericCandidatePayload,
  LIVE_AIRCRAFT_PROVIDERS[1],
  Date.parse('2026-08-15T12:05:01Z'),
  INCIDENT_AIRCRAFT,
  { includeCandidates: true },
)
const corroboratedGeneric = promoteIncidentAircraftCandidates([...genericFromFi, ...genericFromLol])
assert.equal(corroboratedGeneric.length, 0,
  'two providers corroborate a position, not an incident role; generic traffic must not be promoted')
const unrelatedSeparatedRows = promoteIncidentAircraftCandidates([
  genericFromFi[0],
  { ...genericFromFi[0], observedAt: '2026-08-15T13:05:00.000Z' },
])
assert.equal(
  unrelatedSeparatedRows.length,
  0,
  'isolated generic rows separated by more than one operational session must not promote each other',
)

const highAircraft = normalizeAircraft({
  now: 1_786_781_100,
  ac: [{ hex: '4bfffd', flight: 'TRANSIT', lat: 50.55, lon: 6.06, alt_baro: 18_000, gs: 320 }],
}, provider, Date.parse('2026-08-15T12:05:01Z'), INCIDENT_AIRCRAFT, { includeCandidates: true })
assert.equal(highAircraft.length, 0, 'high/fast transit traffic must be rejected before candidate promotion')

const excludedOovst = {
  hex: '44da74',
  flight: 'OOVST ',
  r: 'OO-VST',
  t: 'P06T',
  desc: 'TECNAM P-2006T',
  lat: 50.55,
  lon: 6.06,
  alt_baro: 2_500,
  gs: 95,
}
assert.equal(resolveIncidentAircraft(excludedOovst, INCIDENT_AIRCRAFT, { allowCandidate: true }), null)
assert.equal(normalizeAircraft(
  { now: 1_786_781_100, ac: [excludedOovst] },
  provider,
  Date.parse('2026-08-15T12:05:01Z'),
  INCIDENT_AIRCRAFT,
  { includeCandidates: true },
).length, 0, 'reviewed proximity-only OOVST observations must stay out of incident products')
assert.equal(resolveIncidentAircraft({
  hex: '06a30b', flight: 'QTR8098', r: 'A7-BFX', t: 'B77L',
}, INCIDENT_AIRCRAFT, { allowCandidate: true }), null,
'reviewed scheduled-airline transit traffic must stay out of incident products')

const traceProvider = CURRENT_AIRCRAFT_TRACE_PROVIDERS[0]
const trace = normalizeAircraftTrace({
  timestamp: Date.parse('2026-08-15T08:00:00.000Z') / 1_000,
  trace: [
    [30, 50.55, 6.06, 2_100, 72, 185, 0, 0, { flight: 'G10 ' }, 'mlat'],
    [60, 50.55, 6.06, 2_100, 72, 185, 0, 0, null, 'mlat'],
    [90, 50.80, 6.50, 2_100, 72, 185, 0, 0, null, 'mlat'],
  ],
}, { icao24: '44c1e5', callSign: 'G10', registration: 'OO-POE' }, traceProvider)
assert.equal(trace.length, 3, 'a qualifying trace must retain its complete exact provider route')
assert.equal(trace[0].observedAt, '2026-08-15T08:00:30.000Z')
assert.equal(trace[0].providerId, 'adsb-lol-current-trace')
assert.deepEqual(trace.map((row) => row.routeScope), ['incident-area', 'incident-area', 'full-route'])
assert.equal(normalizeAircraftTrace({
  timestamp: Date.parse('2026-08-15T08:00:00.000Z') / 1_000,
  trace: [[30, 50.80, 6.50, 2_100, 72, 185]],
}, { icao24: '44c1e5', callSign: 'G10', registration: 'OO-POE' }, traceProvider).length, 0,
'a trace that never entered the incident area must not be attached to the incident')
const sessionFilteredTrace = normalizeAircraftTrace({
  timestamp: Date.parse('2026-08-15T08:00:00.000Z') / 1_000,
  trace: [
    [30, 50.80, 6.50, 2_100, 72, 185],
    [3_700, 50.55, 6.06, 2_100, 72, 185],
    [3_730, 50.56, 6.07, 2_100, 72, 185],
  ],
}, { icao24: '44c1e5', callSign: 'G10', registration: 'OO-POE' }, traceProvider)
assert.equal(sessionFilteredTrace.length, 2, 'a separate same-day route that never entered the incident area must be omitted')
assert.ok(sessionFilteredTrace.every((row) => row.routeScope === 'incident-area'))

const discoveredTrace = normalizeAircraftTrace({
  timestamp: Date.parse('2026-08-15T16:45:00.000Z') / 1_000,
  r: 'D-999',
  t: 'H47',
  desc: 'BOEING-VERTOL CH-47 Chinook',
  trace: [[10, 50.55, 6.06, 2_300, 120, 245, 0, 0, { flight: 'GRZLY82 ' }, 'adsb_icao']],
}, {
  icao24: '480999',
  callSign: 'GRZLY82',
  registration: 'D-999',
  selectionBasis: 'incident-callsign',
}, traceProvider)
assert.equal(discoveredTrace.length, 1)
assert.equal(discoveredTrace[0].aircraftType, 'H47')
assert.equal(discoveredTrace[0].selectionBasis, 'incident-callsign')

const d479Trace = normalizeAircraftTrace({
  timestamp: Date.parse('2026-08-16T09:43:49.088Z') / 1_000,
  r: 'D-479',
  t: 'H47',
  desc: 'BOEING-VERTOL CH-47 Chinook',
  trace: [[10, 50.5047, 5.936376, 1_950, 83.7, 27.8, 0, 0, { flight: 'GRZLY81 ' }, 'adsb_icao']],
}, {
  icao24: '480440',
  callSign: 'GRZLY81',
  registration: 'D-479',
  selectionBasis: 'incident-callsign',
}, traceProvider)
assert.equal(d479Trace.length, 1)
assert.equal(d479Trace[0].registration, 'D-479')
assert.equal(d479Trace[0].selectionBasis, 'incident-callsign')

const traceTargets = trackedAircraftFromObservations(discoveredTrace)
assert.equal(traceTargets.length, INCIDENT_AIRCRAFT.size + 1)
assert.equal(traceTargets.find((aircraft) => aircraft.icao24 === '480999').callSign, 'GRZLY82')
const promotedD479 = trackedAircraftFromObservations(d479Trace)
  .find((aircraft) => aircraft.icao24 === '480440')
assert.equal(promotedD479.selectionBasis, 'verified-icao24')
const activeTraceTargets = trackedAircraftFromObservations([...discoveredTrace, ...d479Trace], {
  includeConfigured: false,
  observedAfter: '2026-08-16T00:00:00.000Z',
})
assert.deepEqual(activeTraceTargets.map((aircraft) => aircraft.icao24), ['480440'], 'current trace calls must be limited to recently observed identities')
assert.equal(trackedAircraftFromObservations([{
  icao24: '44da74',
  callSign: 'OOVST',
  observedAt: '2026-08-16T12:00:00.000Z',
  selectionBasis: 'incident-area-corroborated',
}], { includeConfigured: false }).length, 0, 'OOVST must not receive future trace requests')
assert.deepEqual(routeRecoveryTargets([
  { ...d479Trace[0], observedAt: '2026-08-16T09:43:59.000Z' },
  { ...d479Trace[0], observedAt: '2026-08-16T10:00:00.000Z', routeScope: 'full-route' },
  {
    icao24: '44da74',
    callSign: 'OOVST',
    observedAt: '2026-08-16T12:00:00.000Z',
    latitude: 50.55,
    longitude: 6.06,
    distanceDrossartKm: 1,
  },
], '2026-08-16').map((aircraft) => aircraft.icao24), ['480440'])

const displayFlights = mergeIncidentFlights([{ id: 'g10', icao24: '44c1e5', callSign: 'G10', observations: [] }], [
  normalized[0],
  normalized[1],
  normalized[2],
])
assert.equal(displayFlights.length, 3)
assert.equal(displayFlights.find((flight) => flight.icao24 === '480999').type, 'helicopter')
assert.equal(displayFlights.find((flight) => flight.icao24 === '480849').callSign, 'GRZLY81')
const observationEvents = aircraftObservationEvents([
  { ...normalized[0], observedAt: '2026-08-17T08:01:00.000Z' },
  { ...normalized[0], observedAt: '2026-08-17T08:11:00.000Z' },
  { ...normalized[0], observedAt: '2026-08-17T08:12:00.000Z', routeScope: 'full-route' },
], Date.parse('2026-08-14T11:00:00.000Z'), 1_000)
assert.equal(observationEvents.length, 1, 'aircraft fixes on one local day must produce one lightweight timeline event')
assert.equal(observationEvents[0].time, '10:01')
assert.match(observationEvents[0].detail, /10:01 to 10:11 CEST/)

const rawArtifact = buildProviderArtifact({
  sourceKey: 'aircraft-live',
  bucketAt: '2026-08-15T18:45:00.000Z',
  response: {
    provider: LIVE_AIRCRAFT_PROVIDERS[0],
    statusCode: 200,
    contentType: 'application/json',
    rawBody: '{"now":1786819500,"ac":[]}',
  },
})
assert.equal(rawArtifact.contentEncoding, 'gzip')
assert.equal(
  gunzipSync(Buffer.from(rawArtifact.contentBase64, 'base64')).toString('utf8'),
  '{"now":1786819500,"ac":[]}',
  'archived aircraft artifacts must round-trip to the exact provider body',
)

const responseArtifact = buildProviderArtifact({
  sourceKey: 'aircraft-live',
  bucketAt: '2026-08-15T12:05:00.000Z',
  response: {
    provider,
    statusCode: 200,
    contentType: 'application/json',
    rawBody: JSON.stringify({
      now: 1_786_781_100,
      ac: [{ hex: '4bffff', flight: 'SWED01 ', r: 'SE-MAA', t: 'AT8T', lat: 50.55, lon: 6.06, seen_pos: 2, alt_baro: 3_200, gs: 145 }],
    }),
  },
})
const recoveredArtifact = recoverAircraftArtifactObservations([responseArtifact])
assert.equal(recoveredArtifact.observations.length, 1, 'retained raw polls must recover supported response aircraft without a provider call')
assert.equal(recoveredArtifact.observations[0].registration, 'SE-MAA')
assert.equal(recoveredArtifact.promotedCandidateAircraftCount, 1)

const firmsCsv = [
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,frp,daynight',
  '50.55,6.06,345.2,0.4,0.5,2026-08-15,1205,N21,n,42.1,D',
].join('\n')
const firmsFixture = await loadFirms({
  mapKey: 'never-store-this-key',
  requestedAtMs: Date.parse('2026-08-15T12:10:00.000Z'),
  includeRaw: true,
  fetchImpl: async () => new Response(firmsCsv, {
    status: 200,
    headers: { 'Content-Type': 'text/csv' },
  }),
})
assert.equal(firmsFixture.rawResponses.length, 5)
assert.equal(firmsFixture.currentWindowDetectionCount, 5)
assert.equal(firmsFixture.latestAcquiredAt, '2026-08-15T12:05:00.000Z')
assert.ok(firmsFixture.rawResponses.every((item) => item.rawBody === firmsCsv))
assert.ok(firmsFixture.rawResponses.every((item) => !item.provider.endpoint.includes('never-store-this-key')))
const meteosatFixture = firmsFixture.sensors.find((sensor) => sensor.sensorKey === 'meteosat')
assert.equal(meteosatFixture.areaDerivationAllowed, false)
assert.equal(meteosatFixture.areaHa, null)
assert.notEqual(
  firmsDetectionKey({ sensorKey: 'meteosat', satellite: 'Met9', acquiredAt: '2026-08-15T12:05:00.000Z', latitude: 50.55, longitude: 6.06 }),
  firmsDetectionKey({ sensorKey: 'meteosat', satellite: 'Met10', acquiredAt: '2026-08-15T12:05:00.000Z', latitude: 50.55, longitude: 6.06 }),
  'simultaneous detections from distinct Meteosat spacecraft must not collapse in Postgres',
)

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

const stavelotProvider = MUNICIPAL_PROVIDERS.find((item) => item.id === 'stavelot')
const stavelotItems = parseMunicipalRdfFeed(`
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <item rdf:about="https://www.stavelot.be/actualites/incendie-fagnes">
      <title>Incendie en cours dans les Fagnes : point de situation</title>
      <link>https://www.stavelot.be/actualites/incendie-fagnes</link>
      <description></description>
      <dc:date>2026-08-15T14:45:00Z</dc:date>
      <dc:type>News Item</dc:type>
    </item>
  </rdf:RDF>
`)
assert.equal(stavelotItems.length, 1)
const stavelotNotice = normalizeRdfNotice(
  stavelotItems[0],
  stavelotProvider,
  '2026-08-15T15:05:00Z',
  '<div id="parent-fieldname-text"><p>Importantes fumées à Stavelot. Fermez portes et fenêtres.</p></div>',
)
assert.equal(stavelotNotice.publisherKind, 'official-municipal')
assert.match(stavelotNotice.bodyText, /Fermez portes/)
assert.equal(normalizeRdfNotice({
  id: 'unrelated',
  title: 'Installation de bornes de recharge',
  url: 'https://www.stavelot.be/actualites/installation-bornes',
  description: 'Offres à remettre en septembre',
  publishedAt: '2026-08-15T14:45:00Z',
}, stavelotProvider, '2026-08-15T15:05:00Z'), null)
assert.equal(normalizeRdfNotice({
  id: 'generic-emergency-heading',
  title: 'Point de situation à 18 h',
  url: 'https://www.stavelot.be/actualites/point-de-situation-18h',
  description: '',
  publishedAt: '2026-08-15T16:00:00Z',
}, stavelotProvider, '2026-08-15T16:05:00Z', '<div id="parent-fieldname-text"><p>L’incendie reste en cours.</p></div>'), null,
'a generic local fire update without explicit incident-area context must not be admitted')

const waimesProvider = MUNICIPAL_PROVIDERS.find((item) => item.id === 'waimes')
assert.equal(normalizeWaimesNotice({
  UID: 'unrelated-waimes',
  title: 'Enquête publique',
  description: 'Permis pour une menuiserie à Sourbrodt',
  effective: '2026-08-15T14:00:00Z',
}, waimesProvider, '2026-08-15T15:05:00Z'), null)

const jalhayProvider = MUNICIPAL_PROVIDERS.find((item) => item.id === 'jalhay')
const jalhayNotice = normalizeWordpressApiNotice({
  id: 28020,
  date_gmt: '2026-08-15T06:32:12',
  modified_gmt: '2026-08-15T15:51:15',
  link: 'https://www.jalhay.be/feu-fagnes/',
  title: { rendered: 'Incendie dans les Fagnes – [Mise à jour : 15/08 – 17h00]' },
  excerpt: { rendered: '<p>La N68 reste fermée.</p>' },
  content: { rendered: '<p>La N68 reste fermée. Aucune évacuation de la population n’est demandée sur le territoire de Jalhay.</p>' },
}, jalhayProvider, '2026-08-15T16:05:00Z')
assert.equal(jalhayNotice.publishedAt, '2026-08-15T06:32:12.000Z')
assert.equal(jalhayNotice.effectiveAt, '2026-08-15T15:00:00.000Z')
assert.equal(municipalNoticeEvent(jalhayNotice).type, 'closure', 'a no-evacuation notice containing road closures must remain a closure')

const [rss2Item] = parseMunicipalRdfFeed(`
  <rss><channel><item>
    <title>Incendie dans les Fagnes</title>
    <link>https://www.jalhay.be/feu-fagnes/</link>
    <pubDate>Sat, 15 Aug 2026 06:32:12 +0000</pubDate>
    <content:encoded><![CDATA[<p>La N68 est fermée.</p>]]></content:encoded>
  </item></channel></rss>
`)
assert.equal(rss2Item.publishedAt, 'Sat, 15 Aug 2026 06:32:12 +0000')
assert.equal(rss2Item.content, 'La N68 est fermée.')

const eupenProvider = MUNICIPAL_PROVIDERS.find((item) => item.id === 'eupen')
const eupenNotice = normalizeRdfNotice({
  id: 'https://www.eupen.be/brand-im-hohen-venn/',
  title: 'Brand im Hohen Venn',
  url: 'https://www.eupen.be/brand-im-hohen-venn/',
  description: '',
  publishedAt: 'Sat, 15 Aug 2026 09:07:52 +0000',
}, eupenProvider, '2026-08-15T12:20:00Z', `
  <script type="application/ld+json">{"dateModified":"2026-08-15T12:16:02+00:00"}</script>
  <article><div class="entry-content-inner">
    <p><strong>15.8.2026, 11:50 Uhr</strong></p>
    <p>Die N68 bleibt wegen des Brands im Hohen Venn gesperrt.</p>
  </div></article>
`)
assert.equal(eupenNotice.effectiveAt, '2026-08-15T09:50:00.000Z')
assert.equal(eupenNotice.updatedAt, '2026-08-15T12:16:02.000Z')
assert.equal(municipalNoticeEvent(eupenNotice).type, 'closure')

const zoneVhpProvider = MUNICIPAL_PROVIDERS.find((item) => item.id === 'zone-vhp')
const zoneNotice = normalizeWordpressApiNotice({
  id: 5200,
  date_gmt: '2026-08-15T16:00:00',
  modified_gmt: '2026-08-15T16:05:00',
  link: 'https://www.zone-vhp.be/2026/08/15/incendie-hautes-fagnes/',
  title: { rendered: 'Incendie dans les Hautes Fagnes' },
  excerpt: { rendered: '<p>Mise à jour opérationnelle.</p>' },
  content: { rendered: '<p>Le feu reste actif dans les Hautes Fagnes.</p>' },
}, zoneVhpProvider, '2026-08-15T16:10:00Z')
assert.equal(zoneNotice.publisherKind, 'official-emergency-service')

const hlzProvider = MUNICIPAL_PROVIDERS.find((item) => item.id === 'hlz-dg')
const [hlzItem] = parseHlzNewsList(`
  <section class="newslist"><div class="newslist-item">
    <a href="/news/brand-hohes-venn/"><span class="newslist-title">Brand im Hohen Venn</span>
      <div class="img-wrapper"></div><p class="newslist-rawtext">Aktuelle Lage in Küchelscheid.</p></a>
  </div></section>
`)
assert.equal(hlzItem.url, 'https://www.hlzdg.be/news/brand-hohes-venn/')
const hlzNotice = normalizeHlzNotice(hlzItem, `
  <meta property="og:publish_date" content="2026-08-15T16:30:00.0000000" />
  <section class="newsdetail"><p class="lead">15.08.2026, 18:45 Uhr</p><p>Der Brand im Hohen Venn bleibt aktiv.</p></section>
`, hlzProvider, '2026-08-15T16:50:00Z')
assert.equal(hlzNotice.publishedAt, '2026-08-15T14:30:00.000Z')
assert.equal(hlzNotice.effectiveAt, '2026-08-15T16:45:00.000Z')
assert.equal(hlzNotice.publisherKind, 'official-emergency-service')

const eifelPoliceProvider = MUNICIPAL_PROVIDERS.find((item) => item.id === 'eifel-police')
const policeNotice = normalizeWordpressApiNotice({
  id: 1100,
  date_gmt: '2026-08-15T16:00:00',
  modified_gmt: '2026-08-15T16:05:00',
  link: 'https://eifelpolizei.be/brand-hohes-venn/',
  title: { rendered: 'Brand im Hohen Venn' },
  excerpt: { rendered: '<p>Polizeiliche Information.</p>' },
  content: { rendered: '<p>Die Polizei informiert Küchelscheid und Leykaul.</p>' },
}, eifelPoliceProvider, '2026-08-15T16:10:00Z')
assert.equal(policeNotice.publisherKind, 'official-police')

const butgenbachProvider = MUNICIPAL_PROVIDERS.find((item) => item.id === 'butgenbach')
const [butgenbachSitemapItem] = parseButgenbachSitemap(`
  <urlset>
    <url>
      <loc>https://butgenbach.be/wichtige-informationen-kuechelscheid-leykaul/</loc>
      <lastmod>2026-08-15T14:50:50+00:00</lastmod>
    </url>
  </urlset>
`)
assert.equal(butgenbachSitemapItem.id, butgenbachSitemapItem.url)
assert.equal(butgenbachSitemapItem.updatedAt, '2026-08-15T14:50:50.000Z')
const butgenbachNotice = normalizeButgenbachNotice({
  id: 33585,
  title: 'WICHTIGE INFORMATIONEN AN DIE EINWOHNER SOWIE BESUCHER VON KÜCHELSCHEID UND LEYKAUL',
  url: 'https://butgenbach.be/wichtige-informationen-kuechelscheid-leykaul/',
}, `
  <script type="application/ld+json">{"datePublished":"2026-08-15T14:50:50+00:00","dateModified":"2026-08-15T14:50:50+00:00"}</script>
  <div class="wordpress-content card">
    <p class="date">15. August 2026</p>
    <div>WICHTIGE INFORMATION (15.08.26, 16:15 Uhr)</div>
    <div>Aufgrund der aktuellen Lage im Hohen Venn bitten wir die Einwohner, sich auf eine Evakuierung vorzubereiten.</div>
    <div>Wegen Rauch Türen und Fenster geschlossen halten.</div>
  </div>
  <a href="/blog/">Alle Neuigkeiten ansehen</a>
`, butgenbachProvider, '2026-08-15T15:05:00Z')
assert.equal(butgenbachNotice.publishedAt, '2026-08-15T14:50:50.000Z')
assert.equal(butgenbachNotice.effectiveAt, '2026-08-15T14:15:00.000Z')
assert.match(butgenbachNotice.bodyText, /Evakuierung vorzubereiten/)
assert.equal(municipalNoticeEvent(butgenbachNotice).type, 'alert', 'the stored municipal event must preserve evacuation-preparation semantics')
const [preparationEvent] = buildEvents({
  reportRows: [],
  baseEvents: [{
    observedAt: butgenbachNotice.publishedAt,
    title: butgenbachNotice.title,
    detail: butgenbachNotice.summary,
    type: 'alert',
    sourceName: 'Municipality of Bütgenbach',
    sourceUrl: butgenbachNotice.url,
  }],
  alerts: [],
  timelineStartMs: Date.parse('2026-08-14T11:00:00Z'),
  frameCount: 400,
})
assert.equal(preparationEvent.type, 'alert', 'evacuation preparation must not be presented as an evacuation order')

assert.equal(butgenbachSourceConfig.runtime, 'edge')
const proxyPath = '/wp-sitemap-posts-post-1.xml'
const proxyTimestamp = Math.floor(Date.now() / (5 * 60 * 1000))
const proxyToken = 'deterministic-test-token'
const proxySignature = createHmac('sha256', proxyToken)
  .update(`${proxyTimestamp}\n${proxyPath}`)
  .digest('hex')
const previousProxyToken = process.env.INTERNAL_SOURCE_TOKEN
const previousFetch = globalThis.fetch
let proxiedUrl = null
try {
  process.env.INTERNAL_SOURCE_TOKEN = proxyToken
  globalThis.fetch = async (url) => {
    proxiedUrl = String(url)
    return new Response('<urlset />', { status: 200, headers: { 'Content-Type': 'application/xml' } })
  }
  const proxyResponse = await butgenbachSourceHandler(new Request(
    `https://venn-fire.vercel.app/api/butgenbach-source?path=${encodeURIComponent(proxyPath)}`,
    {
      headers: {
        'X-Venn-Timestamp': String(proxyTimestamp),
        'X-Venn-Signature': proxySignature,
      },
    },
  ))
  assert.equal(proxyResponse.status, 200)
  assert.equal(proxiedUrl, `https://butgenbach.be${proxyPath}`)
  assert.match(proxyResponse.headers.get('cache-control'), /no-store/)

  const nestedProxyPath = '/erlass-des-buergermeisters-ueber-das-voruebergehende-verbot-bestimmter-aktivitaeten-auf-dem-see-von-buetgenbach-um-die-wasserentnahme-im-rahmen-der-derzeitigen-brandbekaempfung-zu-ermoeglichen/'
  const nestedProxySignature = createHmac('sha256', proxyToken)
    .update(`${proxyTimestamp}\n${nestedProxyPath}`)
    .digest('hex')
  const nestedProxyResponse = await butgenbachSourceHandler(new Request(
    `https://venn-fire.vercel.app/api/butgenbach-source?path=${encodeURIComponent(nestedProxyPath)}`,
    {
      headers: {
        'X-Venn-Timestamp': String(proxyTimestamp),
        'X-Venn-Signature': nestedProxySignature,
      },
    },
  ))
  assert.equal(nestedProxyResponse.status, 200, 'nested official WordPress article paths must be allowed')
  assert.equal(proxiedUrl, `https://butgenbach.be${nestedProxyPath}`)

  proxiedUrl = null
  const rejectedProxyResponse = await butgenbachSourceHandler(new Request(
    'https://venn-fire.vercel.app/api/butgenbach-source?path=https%3A%2F%2Fexample.test%2F',
    {
      headers: {
        'X-Venn-Timestamp': String(proxyTimestamp),
        'X-Venn-Signature': proxySignature,
      },
    },
  ))
  assert.equal(rejectedProxyResponse.status, 401)
  assert.equal(proxiedUrl, null, 'the signed source route must never become an open proxy')
} finally {
  globalThis.fetch = previousFetch
  if (previousProxyToken == null) delete process.env.INTERNAL_SOURCE_TOKEN
  else process.env.INTERNAL_SOURCE_TOKEN = previousProxyToken
}

console.log(`refresh pipeline verified: ${REFRESH_SOURCES.length} leased sources, local-authority/public/controlled adapters, five-minute grid, semantic history, no-store APIs`)
