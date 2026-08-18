import './news-presentation.css'

const parameters = new URLSearchParams(window.location.search)
const requestedPresentation = parameters.get('presentation')
const shortFormat = ['short', 'shorts', 'vertical'].includes(requestedPresentation)
const enabled = ['news', 'broadcast', 'short', 'shorts', 'vertical'].includes(requestedPresentation)
  || parameters.get('view') === 'news'
const language = parameters.get('lang') === 'en' ? 'en' : 'de'
const translations = {
  de: {
    announcedArea: 'Gemeldete Fläche',
    bestEstimate: 'Unsere Beste Schätzung',
    documentTitle: 'Zeitverlauf des Vennbrands | Venn Fire Watch',
    // The subtitle used to carry the attribution. With it gone, the station
    // moves into the label so the figure is still sourced on air.
    observedWind: 'Wind (RMI)',
    timeline: 'Zeitverlauf des Einsatzes',
  },
  en: {
    announcedArea: 'Announced area',
    bestEstimate: 'Our best estimate',
    documentTitle: 'High Fens wildfire timeline | Venn Fire Watch',
    observedWind: 'Wind (RMI)',
    timeline: 'Incident timeline',
  },
}
const copy = translations[language]

function normalizedText(element) {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

function normalizedDegrees(value) {
  return ((value % 360) + 360) % 360
}

function cardinal(degrees) {
  const labels = language === 'de'
    ? ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
    : ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  return labels[Math.round(normalizedDegrees(degrees) / 22.5) % labels.length]
}

function dashboardMarkup() {
  return `
    <div class="news-summary">
      <article class="news-stat news-stat--wind">
        <i class="news-wind-arrow is-unavailable" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 20V4M6.5 9.5 12 4l5.5 5.5" /></svg>
        </i>
        <span>${copy.observedWind}</span>
        <strong class="news-wind-value">
          <i class="news-wind-copy">
            <b>—</b>
            <em class="news-wind-separator" hidden>·</em>
            <b class="news-wind-speed"></b>
            <small class="news-wind-unit"></small>
          </i>
        </strong>
      </article>
      <article class="news-stat news-stat--announced">
        <span>${copy.announcedArea}</span>
        <strong><b class="news-area-announced">—</b><small class="news-area-announced-unit"></small></strong>
      </article>
      <article class="news-stat">
        <span>${shortFormat ? (language === 'de' ? 'Unsere Schätzung' : 'Our estimate') : copy.bestEstimate}</span>
        <strong><b class="news-area-estimated">—</b><small class="news-area-estimated-unit"></small></strong>
      </article>
    </div>
  `
}

function updateAreas(dashboard) {
  const areaValue = (selector) => {
    const value = normalizedText(document.querySelector(selector)).replace(/\s*ha\s*$/i, '').trim()
    return value || '—'
  }
  const announced = areaValue('.snapshot-card--fire strong')
  const estimated = areaValue('.snapshot-card--estimate strong')
  dashboard.querySelector('.news-area-announced').textContent = announced
  dashboard.querySelector('.news-area-announced-unit').textContent = announced === '—' ? '' : 'ha'
  dashboard.querySelector('.news-area-estimated').textContent = estimated
  dashboard.querySelector('.news-area-estimated-unit').textContent = estimated === '—' ? '' : 'ha'
}

// The broadcast graphic quotes one instrument: the RMI station reading, which is
// the same measurement the map marker and the inspector show. A vector mean of
// two networks was not a figure any source publishes, so it could not be
// attributed on air.
function rmiStationReading() {
  for (const row of document.querySelectorAll('.wind-source-reading')) {
    const children = [...row.children]
    if (!/\bRMI\b/.test(normalizedText(children[1]))) continue
    const rotation = Number.parseFloat(children[0]?.style.getPropertyValue('--wind-rotation'))
    const speedText = normalizedText([...(children[2]?.querySelectorAll('small') ?? [])].at(-1))
    const speed = Number.parseFloat(speedText.replace(',', '.'))
    if (!Number.isFinite(rotation) || !Number.isFinite(speed)) continue
    // The interactive arrow points where the wind travels; the reported
    // direction is where it comes from.
    return { direction: normalizedDegrees(rotation - 180), speed }
  }
  return null
}

function updateWind(dashboard) {
  const reading = rmiStationReading()
  const arrow = dashboard.querySelector('.news-wind-arrow')
  const direction = dashboard.querySelector('.news-wind-copy > b')
  const separator = dashboard.querySelector('.news-wind-separator')
  const speed = dashboard.querySelector('.news-wind-speed')
  const unit = dashboard.querySelector('.news-wind-unit')
  if (!reading) {
    arrow.classList.add('is-unavailable')
    arrow.style.setProperty('--wind-rotation', '0deg')
    setText(direction, '—')
    separator.hidden = true
    setText(speed, '')
    setText(unit, '')
    return
  }

  arrow.classList.remove('is-unavailable')
  arrow.style.setProperty('--wind-rotation', `${normalizedDegrees(reading.direction + 180)}deg`)
  setText(direction, cardinal(reading.direction))
  separator.hidden = false
  setText(speed, Math.round(reading.speed).toLocaleString(language === 'de' ? 'de-BE' : 'en-GB'))
  setText(unit, 'km/h')
}

function setText(element, value) {
  if (element && element.textContent !== value) element.textContent = value
}

const germanMonths = {
  JAN: 'Januar',
  FEB: 'Februar',
  MAR: 'März',
  APR: 'April',
  MAY: 'Mai',
  JUN: 'Juni',
  JUL: 'Juli',
  AUG: 'August',
  SEP: 'September',
  OCT: 'Oktober',
  NOV: 'November',
  DEC: 'Dezember',
}
const compactMonthNumbers = {
  JAN: '01',
  FEB: '02',
  MAR: '03',
  APR: '04',
  MAY: '05',
  JUN: '06',
  JUL: '07',
  AUG: '08',
  SEP: '09',
  OCT: '10',
  NOV: '11',
  DEC: '12',
}

// German writes an ordinal dot after the day and spells the month out:
// "18. August". The app formats day labels as uppercase English abbreviations
// ("18 AUG"), and the replacements this used to do were title-case, so they
// never matched and no month was in fact being localized. Idempotent: an
// already-converted label no longer matches the pattern.
function germanDateLabel(value) {
  return value.replace(/\b(\d{1,2}) ([A-Z]{3})\b/g, (match, day, month) => (
    germanMonths[month] ? `${day}. ${germanMonths[month]}` : match
  ))
}

function compactDateLabel(value) {
  const match = value.match(/\b(\d{1,2}) ([A-Z]{3})\b/)
  if (!match || !compactMonthNumbers[match[2]]) return value
  return `${match[1].padStart(2, '0')}.${compactMonthNumbers[match[2]]}.`
}

function updateLocalizedInterface() {
  setText(document.querySelector('.timeline-title > span'), copy.timeline)
  if (language === 'de') {
    for (const element of document.querySelectorAll('.map-date-chip span, .timeline-title strong, .timeline-now small')) {
      setText(element, germanDateLabel(element.textContent))
    }
  }
  for (const tick of document.querySelectorAll('.timeline-ticks span[data-day]')) {
    const sourceDay = tick.dataset.day
    if (shortFormat && !tick.dataset.shortDay) tick.dataset.shortDay = compactDateLabel(sourceDay)
    const localized = language === 'de' ? germanDateLabel(sourceDay) : sourceDay
    if (tick.dataset.day !== localized) tick.dataset.day = localized
  }
}

function setMapLayer(label, enabled) {
  const normalized = (value) => value?.replace(/\s+/g, ' ').trim()
  const row = [...document.querySelectorAll('.layer-row')].find((element) => (
    normalized(element.querySelector('.layer-copy strong')?.textContent) === label
  ))
  if (!row) return false
  const current = row.getAttribute('aria-pressed') === 'true'
  if (current !== enabled) row.click()
  return true
}

function cleanAttribution() {
  for (const link of document.querySelectorAll('.leaflet-control-attribution a[href*="leafletjs.com"]')) {
    const parent = link.parentNode
    link.remove()
    while (parent?.firstChild) {
      const first = parent.firstChild
      const value = first.textContent ?? ''
      if (!value.trim() || value.trim() === '|') {
        first.remove()
        continue
      }
      if (first.nodeType === Node.TEXT_NODE && /^\s*\|\s*/.test(value)) {
        first.textContent = value.replace(/^\s*\|\s*/, '')
      }
      break
    }
  }
}

function updateDashboard() {
  const dashboard = document.querySelector('#news-presentation-dashboard')
  if (!dashboard) return
  updateAreas(dashboard)
  updateWind(dashboard)
  updateLocalizedInterface()
  cleanAttribution()
}

function restartAtBeginningWhenPlaying(event) {
  const playButton = event.target.closest('.play-button')
  if (!playButton) return
  const range = document.querySelector('.timeline-range')
  if (!range || Number(range.value) < Number(range.max)) return
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter.call(range, range.min)
  range.dispatchEvent(new Event('input', { bubbles: true }))
  range.dispatchEvent(new Event('change', { bubbles: true }))
}

function startNewsPresentation() {
  const root = document.querySelector('#root')
  const map = document.querySelector('.map-region')
  const timeline = document.querySelector('.timeline-range')
  if (!root || !map || !timeline) {
    window.setTimeout(startNewsPresentation, 100)
    return
  }

  const dashboard = document.createElement('section')
  dashboard.id = 'news-presentation-dashboard'
  dashboard.setAttribute('aria-label', 'Timeline news summary')
  dashboard.innerHTML = dashboardMarkup()
  document.body.append(dashboard)

  if (shortFormat) {
    const brand = document.createElement('div')
    brand.id = 'news-presentation-brand'
    brand.setAttribute('aria-label', 'Apyos')
    brand.innerHTML = `
      <span class="news-presentation-brand-mark">
        <img src="/apyos-wordmark.svg" alt="Apyos" />
        <svg viewBox="0 0 733 212" aria-hidden="true">
          <path d="M478.428 144.967c2.74-6.499 5.378-12.754 8.048-19.085 1.211.556 2.323 1.104 3.463 1.585 8.421 3.553 17.241 4.437 26.261 3.781 8.559-.622 16.585-2.982 23.683-7.93 9.836-6.857 16.239-16.247 19.765-27.621 2.889-9.318 3.405-18.872 2.411-28.532-1-9.724-3.967-18.761-9.561-26.848-5.548-8.019-12.658-14.111-21.874-17.572-.165-.062-.32-.147-.559-.259 2.636-6.252 5.258-12.472 7.939-18.833 1.126.43 2.226.805 3.289 1.264 20.368 8.785 33.534 24.009 40.019 45.08 3.079 10.006 3.856 20.315 3.336 30.743-.473 9.456-2.115 18.689-5.895 27.396-9.894 22.791-26.894 37.074-51.4 41.861-14.301 2.794-28.518 2.027-42.432-2.558-2.155-.711-4.248-1.612-6.493-2.472" />
        </svg>
      </span>
    `
    document.body.append(brand)
  }

  let updateQueued = false
  const scheduleUpdate = () => {
    if (updateQueued) return
    updateQueued = true
    requestAnimationFrame(() => {
      updateQueued = false
      updateDashboard()
    })
  }
  new MutationObserver(scheduleUpdate).observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  })
  document.addEventListener('input', scheduleUpdate, true)
  document.addEventListener('click', restartAtBeginningWhenPlaying, true)

  window.dispatchEvent(new Event('resize'))
  window.setTimeout(() => {
    setMapLayer('Drossart model wind', false)
    const waterFit = document.querySelector('button[aria-label="Show fire and water sources"]')
    if (waterFit) waterFit.click()
    else document.querySelector('button[aria-label="Center on fire"]')?.click()
    scheduleUpdate()
  }, 250)
  scheduleUpdate()
}

if (enabled) {
  // Imported here rather than at the top of the module so the interactive app,
  // which loads this file unconditionally, keeps its own font resolution.
  import('./news-presentation-font.css')
  document.documentElement.lang = language
  document.documentElement.dataset.presentation = 'news'
  document.documentElement.dataset.newsFormat = shortFormat ? 'short' : 'landscape'
  document.title = copy.documentTitle
  startNewsPresentation()
}
