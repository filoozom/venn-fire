import { chromium } from '@playwright/test'

const url = process.argv.slice(2).filter((argument) => argument !== '--')[0]
  || 'http://127.0.0.1:5173/?presentation=news&lang=de'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-shell:not(.app-shell--hydrating)')
  await page.waitForSelector('#news-presentation-dashboard')
  await page.waitForFunction(() => document.querySelector('.news-wind-copy b')?.textContent?.trim() !== '—')
  await page.waitForFunction(() => {
    const labels = [...document.querySelectorAll('.map-place-label--water')]
    return labels.length >= 2 && labels.every((element) => {
      const rectangle = element.getBoundingClientRect()
      return rectangle.right > 0 && rectangle.bottom > 0
        && rectangle.left < window.innerWidth && rectangle.top < window.innerHeight
    })
  })

  const state = await page.evaluate(() => {
    const bounds = (selector) => {
      const rectangle = document.querySelector(selector)?.getBoundingClientRect()
      return rectangle ? { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height } : null
    }
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      map: bounds('.map-region'),
      dashboard: bounds('#news-presentation-dashboard'),
      summaryTextAlign: getComputedStyle(document.querySelector('#news-presentation-dashboard .news-stat')).textAlign,
      headerDisplay: getComputedStyle(document.querySelector('.app-header')).display,
      feedItems: document.querySelectorAll('#news-presentation-dashboard .news-update').length,
      wind: document.querySelector('#news-presentation-dashboard .news-wind-copy')?.textContent,
      windArrow: bounds('#news-presentation-dashboard .news-wind-arrow'),
      windCopy: bounds('#news-presentation-dashboard .news-wind-copy'),
      dashboardText: document.querySelector('#news-presentation-dashboard')?.textContent?.replace(/\s+/g, ' ').trim(),
      announced: document.querySelector('#news-presentation-dashboard .news-area-announced')?.textContent,
      estimated: document.querySelector('#news-presentation-dashboard .news-area-estimated')?.textContent,
      gridMarkers: [...document.querySelectorAll('.wind-source-marker b')].filter((element) => element.textContent?.trim() === 'GRID').length,
      waterLabels: [...document.querySelectorAll('.map-place-label--water')].map((element) => ({
        text: element.textContent?.replace(/\s+/g, ' ').trim(),
        visible: (() => {
          const rectangle = element.getBoundingClientRect()
          return rectangle.right > 0 && rectangle.bottom > 0
            && rectangle.left < window.innerWidth && rectangle.top < window.innerHeight
        })(),
      })),
      language: document.documentElement.lang,
      timelineTitle: document.querySelector('.timeline-title > span')?.textContent,
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
  if (state.feedItems !== 0 || /Incident updates|Einsatzmeldungen/u.test(state.dashboardText)) {
    throw new Error(`News update feed is still present: ${JSON.stringify(state)}`)
  }
  if (/Mont Rigi|Aachen-Orsbach/u.test(state.dashboardText)
    || !/aus \d+°/u.test(state.wind) || state.announced === '—' || state.estimated === '—') {
    throw new Error(`News summary is incomplete: ${JSON.stringify(state)}`)
  }
  if (state.dashboard.x !== 34 || state.summaryTextAlign !== 'center'
    || state.language !== 'de' || state.timelineTitle !== 'Zeitverlauf des Einsatzes'
    || !/Unsere Beste Schätzung/u.test(state.dashboardText)
    || /Vektormittel aus zwei Messstationen/u.test(state.dashboardText)) {
    throw new Error(`News summary is not aligned/localized: ${JSON.stringify(state)}`)
  }
  const windArrowCenter = state.windArrow?.y + state.windArrow?.height / 2
  const windCopyCenter = state.windCopy?.y + state.windCopy?.height / 2
  if (!Number.isFinite(windArrowCenter) || !Number.isFinite(windCopyCenter)
    || Math.abs(windArrowCenter - windCopyCenter) > 1) {
    throw new Error(`Wind arrow is not vertically aligned: ${JSON.stringify(state)}`)
  }
  if (state.gridMarkers !== 0 || state.waterLabels.length < 2 || state.waterLabels.some((label) => !label.visible)) {
    throw new Error(`Map grid/water context is incorrect: ${JSON.stringify(state)}`)
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
