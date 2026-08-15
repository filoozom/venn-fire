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
import { REFRESH_SOURCES } from '../server/refresh-sources.mjs'
import { buildEvents } from '../src/data.js'
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
  'local-authority-updates',
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

console.log('refresh pipeline verified: 15 leased sources, local-authority/public/controlled adapters, five-minute grid, semantic history, no-store APIs')
