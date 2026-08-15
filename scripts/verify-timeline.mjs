import { chromium } from '@playwright/test'

const testUrl = process.argv.slice(2).find((argument) => argument !== '--') || 'http://127.0.0.1:5173'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []

page.on('pageerror', (error) => errors.push(error.message))
await page.goto(testUrl, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.timeline-range')

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
  beforeLatestReport: await reportedAreaAt('2026-08-15T11:25:00+02:00'),
  latestReport: await reportedAreaAt('2026-08-15T11:30:00+02:00'),
}

const expected = {
  beforeFirstReport: '—',
  firstOfficialReport: '~60ha',
  eveningOfficialReport: '~100ha',
  morningOfficialReport: '~850ha',
  beforeLatestReport: '~850ha',
  latestReport: '>900ha',
}

Object.entries(expected).forEach(([key, value]) => {
  const normalized = states[key].replace(/\s+/g, '')
  if (normalized !== value) throw new Error(`${key}: expected ${value}, got ${normalized}`)
})

await selectTime('2026-08-15T11:30:00+02:00')
const effisBeforeRetrieval = await page.locator('.snapshot-card--effis').innerText()
await selectTime('2026-08-15T11:35:00+02:00')
const effisAfterRetrieval = await page.locator('.snapshot-card--effis').innerText()
if (!effisBeforeRetrieval.includes('501') || !effisBeforeRetrieval.includes('carried forward')) {
  throw new Error('Last available 14 August EFFIS geometry was not carried across the source gap')
}
if (!effisAfterRetrieval.includes('4,857')) {
  throw new Error('15 August EFFIS geometry did not appear after its retrieval time')
}

const chartBounds = await page.locator('.mini-area-chart path[stroke="#ed754a"]').evaluate((path) => {
  const box = path.getBBox()
  return { x: box.x, y: box.y, width: box.width, height: box.height }
})
if (chartBounds.y < 0 || chartBounds.y + chartBounds.height > 44.01) {
  throw new Error(`Reported-area chart escapes its 44 px viewBox: ${JSON.stringify(chartBounds)}`)
}
if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`)

console.log(JSON.stringify({ states, effisBeforeRetrieval, effisAfterRetrieval, chartBounds }, null, 2))
await browser.close()
