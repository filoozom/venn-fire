import { chromium } from '@playwright/test'

const arguments_ = process.argv.slice(2).filter((argument) => argument !== '--')
const testUrl = arguments_[0] || 'http://127.0.0.1:5173'
const databaseUrl = arguments_[1] || new URL('/api/data', testUrl).href
const proxyDatabase = arguments_.length > 1

async function fetchDatabaseRoute(route) {
  return proxyDatabase ? route.fetch({ url: databaseUrl }) : route.fetch()
}

const browser = await chromium.launch({ headless: true })

// The viewer shell must paint while the uncached database response is still in
// flight. This guards against reintroducing a full-page loading interstitial.
const shellPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
await shellPage.route('**/api/data**', async (route) => {
  const upstream = await fetchDatabaseRoute(route)
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  await route.fulfill({ response: upstream })
})
await shellPage.goto(testUrl, { waitUntil: 'domcontentloaded' })
await shellPage.waitForSelector('.app-shell--hydrating')
const asyncShell = await shellPage.evaluate(() => ({
  oldInterstitialCount: document.body.textContent.includes('Loading incident database') ? 1 : 0,
  workspaceCount: document.querySelectorAll('.async-workspace').length,
  mapCount: document.querySelectorAll('.async-map-region').length,
  blockingStartupCount: document.querySelectorAll('.database-startup').length,
}))
if (asyncShell.oldInterstitialCount || asyncShell.blockingStartupCount
  || asyncShell.workspaceCount !== 1 || asyncShell.mapCount !== 1) {
  throw new Error(`Database hydrate did not render the asynchronous viewer shell: ${JSON.stringify(asyncShell)}`)
}
await shellPage.screenshot({ path: '/tmp/fire-async-shell.png', fullPage: true })
await shellPage.setViewportSize({ width: 390, height: 844 })
await shellPage.waitForTimeout(300)
const mobileAsyncShell = await shellPage.evaluate(() => ({
  viewportWidth: window.innerWidth,
  bodyWidth: document.body.scrollWidth,
  workspaceCount: document.querySelectorAll('.async-workspace').length,
  mapWidth: Math.round(document.querySelector('.async-map-region')?.getBoundingClientRect().width ?? 0),
  sidebarRight: Math.round(document.querySelector('.async-sidebar')?.getBoundingClientRect().right ?? 0),
}))
if (mobileAsyncShell.bodyWidth !== mobileAsyncShell.viewportWidth
  || mobileAsyncShell.workspaceCount !== 1 || mobileAsyncShell.mapWidth !== mobileAsyncShell.viewportWidth
  || mobileAsyncShell.sidebarRight > 0) {
  throw new Error(`Asynchronous viewer shell overflowed on mobile: ${JSON.stringify(mobileAsyncShell)}`)
}
await shellPage.screenshot({ path: '/tmp/fire-async-shell-mobile.png', fullPage: true })
await shellPage.waitForSelector('.timeline-range')
await shellPage.close()

const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []

page.on('pageerror', (error) => errors.push(error.message))
if (proxyDatabase) {
  await page.route('**/api/data**', async (route) => {
    const upstream = await fetchDatabaseRoute(route)
    await route.fulfill({ response: upstream })
  })
}
await page.goto(testUrl, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.timeline-range')
await page.waitForSelector('.app-shell:not(.app-shell--hydrating)')

// Unrelated receiver traffic is an offline audit only. It must not have a
// layer toggle, inspector entry or situation card that could expose it again.
const unrelatedTrafficControls = await page.getByRole('button', { name: /^Traffic\b/i }).count()
  + await page.getByText('All nearby receiver traffic', { exact: true }).count()
  + await page.locator('.snapshot-card--traffic').count()
if (unrelatedTrafficControls !== 0) {
  throw new Error(`Unrelated traffic is still exposed by ${unrelatedTrafficControls} UI control(s)`)
}

await page.locator('.data-button').click()
await page.getByRole('button', { name: 'Source directory' }).click()
const synchronizedSourceLinks = {
  reports: await page.locator('a.directory-row').filter({ hasText: 'Governor and BRF reports' }).count(),
  effis: await page.locator('a.directory-row').filter({ hasText: 'Copernicus EFFIS daily geometry' }).count(),
}
if (Object.values(synchronizedSourceLinks).some((count) => count !== 1)) {
  throw new Error(`Database source registry entries are not exposed exactly once: ${JSON.stringify(synchronizedSourceLinks)}`)
}
await page.getByRole('button', { name: 'Close data workspace' }).click()

const startMs = Date.parse('2026-08-14T13:00:00+02:00')
const fiveMinutesMs = 5 * 60 * 1000

async function selectTime(timestamp) {
  const index = Math.ceil((Date.parse(timestamp) - startMs) / fiveMinutesMs)
  await page.locator('.timeline-range').evaluate((input, value) => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    valueSetter.call(input, String(value))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, index)
  await page.waitForTimeout(30)
}

async function reportedAreaAt(timestamp) {
  await selectTime(timestamp)
  return page.locator('.snapshot-card--fire strong').first().innerText()
}

const states = {
  beforeFirstReport: await reportedAreaAt('2026-08-14T15:55:00+02:00'),
  firstOfficialReport: await reportedAreaAt('2026-08-14T16:00:00+02:00'),
  eveningOfficialReport: await reportedAreaAt('2026-08-14T20:00:00+02:00'),
  morningOfficialReport: await reportedAreaAt('2026-08-15T07:00:00+02:00'),
  beforeFirstBrfReport: await reportedAreaAt('2026-08-15T11:25:00+02:00'),
  firstBrfReport: await reportedAreaAt('2026-08-15T11:30:00+02:00'),
  beforeLatestBrfReport: await reportedAreaAt('2026-08-15T14:25:00+02:00'),
  latestBrfReport: await reportedAreaAt('2026-08-15T14:30:00+02:00'),
}

const expected = {
  beforeFirstReport: '—',
  firstOfficialReport: '~60ha',
  eveningOfficialReport: '~100ha',
  morningOfficialReport: '~850ha',
  beforeFirstBrfReport: '~850ha',
  firstBrfReport: '>900ha',
  beforeLatestBrfReport: '>900ha',
  latestBrfReport: '>1,500ha',
}

Object.entries(expected).forEach(([key, value]) => {
  const normalized = states[key].replace(/\s+/g, '')
  if (normalized !== value) throw new Error(`${key}: expected ${value}, got ${normalized}`)
})

// A lone manoeuvre must not alter the fire outline. After a second nearby GRZLY
// direction change, the conservative lobe must enter the same solid outline and
// hectare figure—never appear as a separate aircraft layer.
await selectTime('2026-08-15T18:55:00+02:00')
const edgeNoteBeforeRepeat = await page.locator('.layer-note').first().innerText()
await selectTime('2026-08-15T21:10:00+02:00')
const edgeAfterRepeat = await page.locator('.outline-method-key').innerText()
const edgeNoteAfterRepeat = await page.locator('.layer-note').first().innerText()
if (edgeNoteBeforeRepeat.includes('additional 50 m cells')) {
  throw new Error(`Aircraft support appeared before repeat support: ${edgeNoteBeforeRepeat}`)
}
if (!edgeAfterRepeat.includes('Single combined outline')
  || edgeAfterRepeat.includes('Aircraft-supported edge')
  || !edgeNoteAfterRepeat.includes('additional 50 m cells')
  || !edgeNoteAfterRepeat.includes('direction changes')) {
  throw new Error(`Aircraft support did not enter the one outline on the expected five-minute frame: ${edgeAfterRepeat} / ${edgeNoteAfterRepeat}`)
}

// The 19:13 UTC Terra pass becomes available at the 19:15 UTC frame. It must
// replace, rather than accumulate with, the earlier Aqua support and extend the
// one solid satellite outline and its matching area figure.
await selectTime('2026-08-15T21:10:00+02:00')
const modisBeforeTerra = await page.locator('.layer-note').first().innerText()
const areaBeforeTerra = await page.locator('.snapshot-card--estimate strong').innerText()
await selectTime('2026-08-15T21:15:00+02:00')
const modisAfterTerra = await page.locator('.layer-note').first().innerText()
const areaAfterTerra = await page.locator('.snapshot-card--estimate strong').innerText()
const estimateMethodKey = await page.locator('.outline-method-key').innerText()
if (!modisBeforeTerra.includes('high-confidence Aqua MODIS pixels')
  || !modisAfterTerra.includes('13 high-confidence Terra MODIS pixels')
  || !estimateMethodKey.includes('Single combined outline')
  || estimateMethodKey.includes('MODIS-supported extent')) {
  throw new Error(`MODIS support did not switch on the expected five-minute frame: ${modisBeforeTerra} / ${modisAfterTerra}`)
}
if (areaBeforeTerra.replace(/\s+/gu, '') === areaAfterTerra.replace(/\s+/gu, '')) {
  throw new Error(`Merged MODIS geometry did not update the matching estimate area: ${areaBeforeTerra} -> ${areaAfterTerra}`)
}

await selectTime('2026-08-15T14:30:00+02:00')
const bundledLatestAreaLogEntries = await page.getByText('>1,500 ha reported affected', { exact: true }).count()
if (bundledLatestAreaLogEntries !== 1) {
  throw new Error(`Bundled >1,500 ha report reached the card but not exactly one log entry (${bundledLatestAreaLogEntries})`)
}

// Each EFFIS product is gated on its own product date, never on retrievedAt.
// Our fetch time must not decide when published data appears on the timeline:
// gating on it made the 15 August product surface only from 11:33 CEST, and any
// later re-import would have pushed it later still.
await selectTime('2026-08-14T23:55:00+02:00')
const effisOn14August = await page.locator('.snapshot-card--effis').innerText()
await selectTime('2026-08-15T00:05:00+02:00')
const effisOn15August = await page.locator('.snapshot-card--effis').innerText()
if (!effisOn14August.includes('2026-08-14')) {
  throw new Error('14 August EFFIS geometry was not shown on 14 August')
}
if (effisOn14August.includes('carried forward')) {
  throw new Error('14 August EFFIS geometry was labelled carried forward on its own product date')
}
if (!effisOn15August.includes('2026-08-15') || effisOn15August.includes('carried forward')) {
  throw new Error('15 August EFFIS geometry did not appear at the start of 15 August')
}

const chartBounds = await page.locator('.mini-area-chart path[stroke="#ed754a"]').evaluate((path) => {
  const box = path.getBBox()
  return { x: box.x, y: box.y, width: box.width, height: box.height }
})
if (chartBounds.y < 0 || chartBounds.y + chartBounds.height > 44.01) {
  throw new Error(`Reported-area chart escapes its 44 px viewBox: ${JSON.stringify(chartBounds)}`)
}

// A database report update must advance the timeline independently of any
// provider request. The browser consumes only the normalized Postgres view.
const livePage = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const liveErrors = []
livePage.on('pageerror', (error) => liveErrors.push(error.message))
await livePage.route('**/api/data**', async (route) => {
  const upstream = await fetchDatabaseRoute(route)
  const payload = await upstream.json()
  payload.generatedAt = '2026-08-15T13:10:00.000Z'
  if (payload.datasets?.reports) payload.datasets.reports.payload = {
    ...payload.datasets.reports.payload,
    ok: true,
    complete: true,
    areaReports: [...payload.datasets.reports.payload.areaReports, {
      timestampMs: Date.parse('2026-08-15T15:05:00+02:00'),
      observedAt: '2026-08-15T13:05:00.000Z',
      reportedHa: 1600,
      areaPrefix: '>',
      areaLabel: 'fixture report at 15:05 CEST',
      source: 'BRF',
      sourceUrl: 'https://brf.be/regional/2100196/',
    }],
  }
  await route.fulfill({ response: upstream, json: payload })
})
await livePage.goto(testUrl, { waitUntil: 'domcontentloaded' })
await livePage.waitForFunction(() => (
  document.querySelector('.snapshot-card--fire strong')?.textContent.replace(/\s+/gu, '') === '>1,600ha'
))
const databaseReportUpdate = {
  area: await livePage.locator('.snapshot-card--fire strong').innerText(),
  latestFrame: await livePage.locator('.updated-state strong').innerText(),
  syncLabel: await livePage.locator('.updated-state small').innerText(),
  logEntries: await livePage.getByText('>1,600 ha reported affected', { exact: true }).count(),
}
if (!databaseReportUpdate.latestFrame.includes('15:10')) {
  throw new Error(`Database report did not advance the timeline: ${JSON.stringify(databaseReportUpdate)}`)
}
if (databaseReportUpdate.logEntries !== 1) {
  throw new Error(`Database report reached the card but not exactly one log entry: ${JSON.stringify(databaseReportUpdate)}`)
}
if (liveErrors.length) throw new Error(`Live-report browser errors: ${liveErrors.join(' | ')}`)
if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`)

console.log(JSON.stringify({ asyncShell, mobileAsyncShell, states, aircraftEdgeTimeline: { edgeBeforeRepeat, edgeAfterRepeat, edgeNoteAfterRepeat }, modisExtentTimeline: { modisBeforeTerra, modisAfterTerra, areaBeforeTerra, areaAfterTerra, estimateMethodKey }, bundledLatestAreaLogEntries, effisOn14August, effisOn15August, unrelatedTrafficControls, officialSourceLinks, chartBounds, databaseReportUpdate }, null, 2))
await browser.close()
