import liveReportsHandler, {
  buildLiveReportsResponse,
  filterPublicAlerts,
  loadAreaReports,
  parseBrfAreaReport,
  parseGovernorAreaReports,
  parseGovernorSituationEvents,
} from '../api/live-reports.js'
import { buildEvents } from '../src/data.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(typeof liveReportsHandler === 'function', 'Vercel /api/live-reports has no default HTTP handler')

const governorFixture = `
  <main>
    <h2>POINT DE SITUATION 15/08/2026 - 16H00</h2>
    <p>Message : ordre d'évacuation préventif</p>
    <p>En raison des vents changeants et de l'importante fumée présente dans la zone, il est demandé aux habitants des rues suivantes d'évacuer leur domicile à titre préventif.</p>
    <p>WAIMES : Rue d'Averscheidt, Rue Haute, Rue du Bouvier, Rue de Bosfagne, Rue coin du bois, Rue Sainte Apolline, Chemin des Champs, Rue de la Roer, Voie des Hôtes, Rue Pré Louis, Rue Clair Chêne, Rue des Tourbières, Rue des Tchenas, Rue de la Station, Am Rurbusch, Rue du camp, À la croix Marquet</p>
    <p>BÜTGENBACH : Rurstraße, Leykaul, Am Breitenbach, Schieferweg, Auf dem Hau, Rickshelderweg, Am Schwarzbach</p>
    <p>Un accueil est organisé au Centre sportif de Malmedy, Avenue du Pont de la Warche 1, 4960 Malmedy.</p>
    <p>Les habitants des autres rues doivent rester chez eux, portes et fenêtres fermées. Les touristes présents dans la zone sont invités à rentrer chez eux.</p>
    <h2>POINT DE SITUATION 15/08/2026 - 7h00</h2>
    <p>À ce stade, le sinistre a déjà affecté près de 850 hectares.</p>
    <h2>POINT DE SITUATION 14/08/2026 - 20H00</h2>
    <p>La police et les pompiers luttent contre l'incendie qui a détruit une centaine d'hectares.</p>
    <h2>DECLENCHEMENT PHASE PROVINCIALE 14/08/2026 - 16h00</h2>
    <p>L'incendie a déjà dévasté une surface estimée à 600&nbsp;000 mètres carrés.</p>
  </main>
`

const governorReports = parseGovernorAreaReports(governorFixture)
assert(governorReports.length === 3, `Expected three Governor reports, got ${governorReports.length}`)
assert(
  JSON.stringify(governorReports.map(({ reportedHa, areaPrefix }) => [reportedHa, areaPrefix]))
    === JSON.stringify([[60, '~'], [100, '~'], [850, '~']]),
  `Governor hectare parsing changed: ${JSON.stringify(governorReports)}`,
)
assert(
  governorReports[2].timestampMs === Date.parse('2026-08-15T07:00:00+02:00'),
  'Governor report was not linked to its bulletin time',
)

const governorEvents = parseGovernorSituationEvents(governorFixture)
assert(governorEvents.length === 1, `Expected one strict Governor evacuation event, got ${governorEvents.length}`)
const evacuation = governorEvents[0]
assert(evacuation.timestampMs === Date.parse('2026-08-15T16:00:00+02:00'), 'Evacuation was not linked to 16:00 CEST')
assert(evacuation.type === 'evacuation', 'The first actual evacuation order needs its own event type')
assert(evacuation.scopeKind === 'named-streets', 'The evacuation must not be widened to a village or municipality')
assert(evacuation.affectedAreas[0].streets.length === 17, 'The Waimes street list is incomplete')
assert(evacuation.affectedAreas[1].streets.length === 7, 'The Bütgenbach street list is incomplete')
assert(!evacuation.title.includes('Ovifat'), 'The source does not authorize a village-wide Ovifat label')
assert(
  parseGovernorSituationEvents(governorFixture.replace('Am Schwarzbach', '')).length === 0,
  'An incomplete official street list must fail the strict evacuation parser',
)

const timelineEvents = buildEvents({
  reportRows: governorReports,
  baseEvents: governorEvents,
  alerts: [],
  timelineStartMs: Date.parse('2026-08-14T11:00:00.000Z'),
  frameCount: 400,
})
const timelineEvacuation = timelineEvents.find((event) => event.id === evacuation.id)
assert(timelineEvacuation?.time === '16:00', 'The retained evacuation was not placed at 16:00 on the UI timeline')
assert(timelineEvacuation?.frame === 324, 'The retained evacuation was not mapped to its exact five-minute frame')

const classifiedEvents = buildEvents({
  reportRows: [],
  baseEvents: [
    ...governorEvents,
    {
      id: 'sourbrodt-standby',
      frame: 298,
      time: '13:50',
      type: 'evacuation',
      title: 'Sourbrodt put on evacuation standby',
      detail: "Aucune évacuation n'est actuellement ordonnée.",
    },
    {
      id: 'venn-clearance',
      frame: 43,
      time: '16:34',
      type: 'evacuation',
      title: 'Venn ordered cleared',
      detail: 'Everyone present must leave the Hohes Venn immediately. No residential evacuation ordered.',
    },
  ],
  alerts: [],
  timelineStartMs: Date.parse('2026-08-14T11:00:00.000Z'),
  frameCount: 400,
})
assert(classifiedEvents.find((event) => event.id === evacuation.id)?.type === 'evacuation', 'The actual order lost its evacuation classification')
assert(classifiedEvents.find((event) => event.id === 'sourbrodt-standby')?.type === 'alert', 'The Sourbrodt standby must not be presented as an evacuation order')
assert(classifiedEvents.find((event) => event.id === 'venn-clearance')?.type === 'closure', 'The Venn area clearance must not be presented as a residential evacuation order')

const brfFixture = `
  <head>
    <meta name="description" content="Der Großbrand im Hohen Venn hält die Einsatzkräfte in Atem. Schätzungen gehen davon aus, dass mittlerweile mehr als 1.500 Hektar Fläche in Flammen stehen." />
  </head>
  <body>
    <time class="date" datetime="2026-08-15 06:37">15.08.2026</time>
    <time title="Bearbeitet am" class="edit">15.08.2026 - 14:30</time>
    <p>Im Jahr 2011 waren rund 1.200 Hektar betroffen.</p>
    <p>Ein älterer Absatz nennt mehr als 900 Hektar.</p>
  </body>
`

const brfReports = parseBrfAreaReport(brfFixture)
assert(brfReports.length === 1, `Expected one BRF report, got ${brfReports.length}`)
assert(brfReports[0].reportedHa === 1500 && brfReports[0].areaPrefix === '>', 'BRF did not select the current lead estimate')
assert(brfReports[0].timestampMs === Date.parse('2026-08-15T14:30:00+02:00'), 'BRF estimate was not linked to the edit time')

const truncatedDescriptionBrf = parseBrfAreaReport(`
  <meta name="description" content="Wegen des Großbrandes im Hohen Venn könnte der föderale Notfallplan aktiviert werden." />
  <time title="Bearbeitet am" class="edit">15.08.2026 - 15:24</time>
  <article><p>Schätzungen gehen davon aus, dass mittlerweile mehr als 1.500 Hektar Fläche in Flammen stehen.</p></article>
`)
assert(
  truncatedDescriptionBrf.length === 1 && truncatedDescriptionBrf[0].reportedHa === 1500,
  'BRF must fall back to the qualified article estimate when its meta description is truncated',
)

const ambiguousBrf = parseBrfAreaReport(`
  <meta name="description" content="Großbrand im Hohen Venn: 2.000 Hektar werden im Artikel erwähnt." />
  <time class="edit">15.08.2026 - 15:00</time>
`)
assert(ambiguousBrf.length === 0, 'An unqualified BRF number must not become an area report')

const partial = await loadAreaReports([
  {
    id: 'governor',
    name: 'Governor',
    url: 'https://example.test/governor',
    parser: parseGovernorAreaReports,
    eventParser: parseGovernorSituationEvents,
  },
  { id: 'failed', name: 'Failed', url: 'https://example.test/failed', parser: parseBrfAreaReport },
], async (source) => {
  if (source.id === 'failed') throw new Error('fixture failure')
  return governorFixture
})
assert(partial.ok && !partial.complete, 'One healthy report source should be explicitly partial')
assert(partial.areaReports.length === 3, 'Healthy reports were lost when another source failed')
assert(partial.events.length === 1, 'The strict Governor evacuation event was not returned by the poller')
assert(partial.sources.filter((source) => source.ok).length === 1, 'Report source health is wrong')

const alertFixtures = [
  {
    guid: 'expired-ovifat',
    title: 'Alerte préventive – Population d’Ovifat',
    capDescription: 'Préparez les effets essentiels; aucune évacuation actuellement ordonnée.',
    areaDesc: 'Ovifat',
    expiresAt: '2026-08-15T14:00:00Z',
  },
  {
    guid: 'sourbrodt',
    title: 'Alerte préventive – Population de Sourbrodt',
    areaDesc: 'Sourbrodt',
  },
]
assert(filterPublicAlerts(alertFixtures, 'OVIFAT').length === 1, 'Public-alert text filtering is not case-insensitive')
const endpointFixture = buildLiveReportsResponse({
  alertsDataset: {
    payload: { alerts: alertFixtures, currentlyInForce: [], alertCount: 2 },
    refreshedAt: '2026-08-15T14:15:00.000Z',
    sourceUpdatedAt: '2026-08-15T14:14:55.000Z',
  },
  reportsDataset: { payload: partial, refreshedAt: '2026-08-15T14:15:00.000Z' },
  query: 'Ovifat',
  generatedAt: '2026-08-15T14:16:00.000Z',
})
assert(endpointFixture.publicAlerts.matchCount === 1, 'Dedicated endpoint did not return the matching expired alert')
assert(endpointFixture.publicAlerts.totalAlertCount === 2, 'Dedicated endpoint lost the accumulated alert total')
assert(endpointFixture.publicAlerts.currentlyInForce.length === 0, 'Expired fixture was incorrectly marked in force')
assert(endpointFixture.publicAlerts.databaseRefreshedAt === '2026-08-15T14:15:00.000Z', 'Endpoint omitted database freshness')

console.log(JSON.stringify({
  governor: governorReports,
  governorEvents,
  brf: brfReports,
  strictAmbiguousMatches: ambiguousBrf.length,
  partialSourceStatus: partial.sources,
  endpointFixture: {
    query: endpointFixture.query,
    matchCount: endpointFixture.publicAlerts.matchCount,
    totalAlertCount: endpointFixture.publicAlerts.totalAlertCount,
    matchedGuid: endpointFixture.publicAlerts.alerts[0].guid,
  },
}, null, 2))
