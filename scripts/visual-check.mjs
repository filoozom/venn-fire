import { chromium } from '@playwright/test'

const testUrl = process.argv[2] || 'http://127.0.0.1:5173'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
const errors = []

page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(error.message))

await page.goto(testUrl, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.timeline-panel')
await page.waitForTimeout(3500)

const layout = await page.evaluate(() => ({
  viewport: { width: window.innerWidth, height: window.innerHeight },
  body: { width: document.body.scrollWidth, height: document.body.scrollHeight },
  timeline: document.querySelector('.timeline-panel')?.getBoundingClientRect().toJSON(),
  map: document.querySelector('.map-region')?.getBoundingClientRect().toJSON(),
  visibleCards: document.querySelectorAll('.snapshot-card').length,
  mapTiles: document.querySelectorAll('.leaflet-tile-loaded').length,
  aircraftMarkers: document.querySelectorAll('.aircraft-map-marker').length,
  aircraftSnapshot: [...document.querySelectorAll('.snapshot-card')].find((card) => card.textContent.includes('AIRCRAFT'))?.textContent.trim(),
  windArrowTransform: getComputedStyle(document.querySelector('.big-wind-arrow svg')).transform,
}))

await page.screenshot({ path: '/tmp/fire-dashboard.png', fullPage: true })

await page.getByRole('button', { name: /Air ops/ }).click()
await page.waitForTimeout(250)
const airCards = await page.locator('.flight-card').count()
const flightStates = await page.locator('.flight-state').allTextContents()

await page.getByRole('button', { name: /Data & sources/ }).click()
await page.waitForSelector('.data-modal')
await page.waitForTimeout(300)
await page.screenshot({ path: '/tmp/fire-data-modal.png', fullPage: true })

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })
const mobileErrors = []
mobile.on('console', (message) => {
  if (message.type() === 'error') mobileErrors.push(message.text())
})
mobile.on('pageerror', (error) => mobileErrors.push(error.message))
await mobile.goto(testUrl, { waitUntil: 'domcontentloaded' })
await mobile.waitForSelector('.timeline-panel')
await mobile.waitForTimeout(1800)
const mobileLayout = await mobile.evaluate(() => ({
  viewport: { width: window.innerWidth, height: window.innerHeight },
  body: { width: document.body.scrollWidth, height: document.body.scrollHeight },
  timeline: document.querySelector('.timeline-panel')?.getBoundingClientRect().toJSON(),
  map: document.querySelector('.map-region')?.getBoundingClientRect().toJSON(),
}))
await mobile.screenshot({ path: '/tmp/fire-dashboard-mobile.png', fullPage: true })

console.log(JSON.stringify({ layout, airCards, flightStates, errors, mobileLayout, mobileErrors }, null, 2))
await browser.close()
