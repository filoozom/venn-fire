import { chromium } from '@playwright/test'

const url = process.argv.slice(2).filter((argument) => argument !== '--')[0]
  || 'http://127.0.0.1:5173/?presentation=news'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-shell:not(.app-shell--hydrating)')
  await page.waitForSelector('#news-presentation-dashboard')
  await page.waitForFunction(() => document.querySelector('.news-wind-copy b')?.textContent?.trim() !== '—')

  const state = await page.evaluate(() => {
    const bounds = (selector) => {
      const rectangle = document.querySelector(selector)?.getBoundingClientRect()
      return rectangle ? { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height } : null
    }
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      map: bounds('.map-region'),
      headerDisplay: getComputedStyle(document.querySelector('.app-header')).display,
      feedItems: document.querySelectorAll('#news-presentation-dashboard .news-update').length,
      feedCount: document.querySelector('#news-presentation-dashboard .news-feed-head small')?.textContent,
      wind: document.querySelector('#news-presentation-dashboard .news-wind-copy')?.textContent,
      windSources: document.querySelector('#news-presentation-dashboard .news-wind-sources')?.textContent,
      announced: document.querySelector('#news-presentation-dashboard .news-area-announced')?.textContent,
      estimated: document.querySelector('#news-presentation-dashboard .news-area-estimated')?.textContent,
      leafletBrandLinks: document.querySelectorAll('.leaflet-control-attribution a[href*="leafletjs.com"]').length,
      attribution: document.querySelector('.leaflet-control-attribution')?.textContent?.replace(/\s+/g, ' ').trim(),
      playDisplay: getComputedStyle(document.querySelector('.play-button')).display,
      timelineValue: Number(document.querySelector('.timeline-range')?.value),
      timelineMax: Number(document.querySelector('.timeline-range')?.max),
    }
  })

  if (!state.map || state.map.x !== 0 || state.map.y !== 0
    || state.map.width !== state.viewport.width || state.map.height !== state.viewport.height) {
    throw new Error(`News map is not fullscreen: ${JSON.stringify(state)}`)
  }
  if (state.headerDisplay !== 'none' || state.playDisplay === 'none') {
    throw new Error(`News chrome/play state is incorrect: ${JSON.stringify(state)}`)
  }
  if (state.feedItems !== 5 || !/^\d+ sourced$/u.test(state.feedCount)) {
    throw new Error(`News update feed is incomplete: ${JSON.stringify(state)}`)
  }
  if (!/Mont Rigi \+ Aachen-Orsbach/u.test(state.windSources)
    || !/from \d+°/u.test(state.wind) || state.announced === '—' || state.estimated === '—') {
    throw new Error(`News summary is incomplete: ${JSON.stringify(state)}`)
  }
  if (state.leafletBrandLinks !== 0 || !/OpenStreetMap/u.test(state.attribution) || /^\s*\|/u.test(state.attribution)) {
    throw new Error(`Attribution was removed or not cleaned correctly: ${JSON.stringify(state)}`)
  }
  if (state.timelineValue !== state.timelineMax) {
    throw new Error(`News timeline did not open at the latest frame: ${JSON.stringify(state)}`)
  }

  await page.locator('.play-button').click()
  await page.waitForFunction(() => Number(document.querySelector('.timeline-range')?.value) < 3)
  await page.waitForTimeout(1_250)
  const replayedFrame = await page.locator('.timeline-range').inputValue()
  if (Number(replayedFrame) < 1) throw new Error(`News replay did not advance from the start: ${replayedFrame}`)
  await page.locator('.play-button').click()

  if (pageErrors.length) throw new Error(`News page errors: ${pageErrors.join(' | ')}`)
  await page.screenshot({ path: '/tmp/venn-fire-live-news-verified.png', fullPage: false })
  console.log(JSON.stringify({ ok: true, url, ...state, replayedFrame: Number(replayedFrame) }, null, 2))
} finally {
  await browser.close()
}
