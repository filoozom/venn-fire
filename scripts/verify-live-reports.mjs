import {
  loadAreaReports,
  parseBrfAreaReport,
  parseGovernorAreaReports,
} from '../api/live-reports.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const governorFixture = `
  <main>
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

const ambiguousBrf = parseBrfAreaReport(`
  <meta name="description" content="Großbrand im Hohen Venn: 2.000 Hektar werden im Artikel erwähnt." />
  <time class="edit">15.08.2026 - 15:00</time>
`)
assert(ambiguousBrf.length === 0, 'An unqualified BRF number must not become an area report')

const partial = await loadAreaReports([
  { id: 'governor', name: 'Governor', url: 'https://example.test/governor', parser: parseGovernorAreaReports },
  { id: 'failed', name: 'Failed', url: 'https://example.test/failed', parser: parseBrfAreaReport },
], async (source) => {
  if (source.id === 'failed') throw new Error('fixture failure')
  return governorFixture
})
assert(partial.ok && !partial.complete, 'One healthy report source should be explicitly partial')
assert(partial.areaReports.length === 3, 'Healthy reports were lost when another source failed')
assert(partial.sources.filter((source) => source.ok).length === 1, 'Report source health is wrong')

console.log(JSON.stringify({
  governor: governorReports,
  brf: brfReports,
  strictAmbiguousMatches: ambiguousBrf.length,
  partialSourceStatus: partial.sources,
}, null, 2))
