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
    const elementBounds = (element) => {
      const rectangle = element?.getBoundingClientRect()
      return rectangle ? { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height } : null
    }
    const bounds = (selector) => elementBounds(document.querySelector(selector))
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      map: bounds('.map-region'),
      dashboard: bounds('#news-presentation-dashboard'),
      summaryTextAlign: getComputedStyle(document.querySelector('#news-presentation-dashboard .news-stat')).textAlign,
      headerDisplay: getComputedStyle(document.querySelector('.app-header')).display,
      feedItems: document.querySelectorAll('#news-presentation-dashboard .news-update').length,
      wind: document.querySelector('#news-presentation-dashboard .news-stat--wind')?.textContent?.replace(/\s+/g, ' ').trim(),
      windArrow: bounds('#news-presentation-dashboard .news-wind-arrow'),
      windCopy: bounds('#news-presentation-dashboard .news-wind-copy'),
      summaryCards: [...document.querySelectorAll('#news-presentation-dashboard .news-stat')].map(elementBounds),
      summaryRows: [...document.querySelectorAll('#news-presentation-dashboard .news-stat')].map((card) => ({
        title: elementBounds(card.querySelector(':scope > span')),
        primary: elementBounds(card.querySelector(':scope > strong')),
        secondary: elementBounds(card.querySelector(':scope > small')),
      })),
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
  if (state.dashboard.x !== 34 || state.dashboard.width !== 840 || state.summaryTextAlign !== 'center'
    || state.language !== 'de' || state.timelineTitle !== 'Zeitverlauf des Einsatzes'
    || !/Unsere Beste Schätzung/u.test(state.dashboardText)
    || /Vektormittel aus zwei Messstationen/u.test(state.dashboardText)) {
    throw new Error(`News summary is not aligned/localized: ${JSON.stringify(state)}`)
  }
  const windArrowCenter = state.windArrow?.y + state.windArrow?.height / 2
  const windCopyCenter = state.windCopy?.y + state.windCopy?.height / 2
  if (!Number.isFinite(windArrowCenter) || !Number.isFinite(windCopyCenter)
    || Math.abs(windArrowCenter - windCopyCenter) > 1
    || Math.abs(state.windArrow.y - state.summaryRows[0].title.y) > 0.5
    || Math.abs((state.windArrow.y + state.windArrow.height)
      - (state.summaryRows[0].secondary.y + state.summaryRows[0].secondary.height)) > 0.5) {
    throw new Error(`Wind arrow is not vertically aligned: ${JSON.stringify(state)}`)
  }
  const referenceRows = state.summaryRows[0]
  const rowsAligned = state.summaryRows.length === 3
    && ['title', 'primary', 'secondary'].every((row) => state.summaryRows.every((card) => (
      Math.abs(card[row].y - referenceRows[row].y) <= 0.5
      && Math.abs(card[row].height - referenceRows[row].height) <= 0.5
    )))
    && state.summaryCards.every((card) => Math.abs(card.width - state.summaryCards[0].width) <= 0.5)
  if (!rowsAligned) {
    throw new Error(`News summary rows are not aligned: ${JSON.stringify(state)}`)
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

  const flightFrames = await page.locator('.event-markers .is-flight').evaluateAll((markers, maximum) => (
    markers.map((marker) => Math.round(Number.parseFloat(marker.style.left) * maximum / 100))
  ), state.timelineMax)
  let aircraftMarker = null
  for (const frame of flightFrames) {
    await page.locator('.timeline-range').evaluate((range, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter.call(range, String(value))
      range.dispatchEvent(new Event('input', { bubbles: true }))
      range.dispatchEvent(new Event('change', { bubbles: true }))
    }, frame)
    await page.waitForTimeout(100)
    if (await page.locator('.aircraft-map-marker').count()) {
      aircraftMarker = await page.evaluate(() => {
        const bounds = (selector) => {
          const rectangle = document.querySelector(selector)?.getBoundingClientRect()
          return rectangle ? { width: rectangle.width, height: rectangle.height } : null
        }
        return {
          symbol: bounds('.aircraft-map-marker > span'),
          label: bounds('.aircraft-map-marker > b'),
        }
      })
      break
    }
  }
  if (!aircraftMarker || aircraftMarker.symbol.width < 45 || aircraftMarker.label.height < 19) {
    throw new Error(`Broadcast aircraft marker is too small: ${JSON.stringify({ flightFrames, aircraftMarker })}`)
  }
  await page.screenshot({ path: '/tmp/venn-fire-news-flight-verified.png', fullPage: false })
  await page.locator('.timeline-range').evaluate((range) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter.call(range, range.max)
    range.dispatchEvent(new Event('input', { bubbles: true }))
    range.dispatchEvent(new Event('change', { bubbles: true }))
  })

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
