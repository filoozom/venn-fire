import './news-presentation.css'

const parameters = new URLSearchParams(window.location.search)
const enabled = ['news', 'broadcast'].includes(parameters.get('presentation'))
  || parameters.get('view') === 'news'
const language = parameters.get('lang') === 'en' ? 'en' : 'de'
const translations = {
  de: {
    announcedArea: 'Gemeldete Fläche',
    announcedAreaSource: 'Offizielle öffentliche Meldungen',
    bestEstimate: 'Unsere Beste Schätzung',
    bestEstimateSource: 'Aus Beobachtungen abgeleitete Kontur',
    documentTitle: 'Zeitverlauf des Vennbrands | Venn Fire Watch',
    meanWind: 'Beobachteter Wind',
    noConcurrentReadings: 'Keine zwei zeitgleichen Messungen',
    timeline: 'Zeitverlauf des Einsatzes',
    twoNearestStations: 'Zwei nächstgelegene Messstationen',
    vectorMean: 'Vektormittel',
  },
  en: {
    announcedArea: 'Announced area',
    announcedAreaSource: 'Official public reports',
    bestEstimate: 'Our best estimate',
    bestEstimateSource: 'Derived observation outline',
    documentTitle: 'High Fens wildfire timeline | Venn Fire Watch',
    meanWind: 'Observed wind',
    noConcurrentReadings: 'No two concurrent observations',
    timeline: 'Incident timeline',
    twoNearestStations: 'Two nearest weather stations',
    vectorMean: 'vector mean',
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
        <span>${copy.meanWind}</span>
        <strong class="news-wind-value">
          <i class="news-wind-copy"><b>—</b></i>
        </strong>
        <small class="news-wind-detail">${copy.twoNearestStations}</small>
      </article>
      <article class="news-stat">
        <span>${copy.announcedArea}</span>
        <strong><b class="news-area-announced">—</b><small class="news-area-announced-unit"></small></strong>
        <small>${copy.announcedAreaSource}</small>
      </article>
      <article class="news-stat">
        <span>${copy.bestEstimate}</span>
        <strong><b class="news-area-estimated">—</b><small class="news-area-estimated-unit"></small></strong>
        <small>${copy.bestEstimateSource}</small>
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

function stationReadings() {
  return [...document.querySelectorAll('.wind-source-reading')].flatMap((row) => {
    const children = [...row.children]
    const name = normalizedText(children[1]?.querySelector('strong'))
    if (!name || name === 'Drossart grid') return []
    const rotation = Number.parseFloat(children[0]?.style.getPropertyValue('--wind-rotation'))
    const speedText = normalizedText([...(children[2]?.querySelectorAll('small') ?? [])].at(-1))
    const speed = Number.parseFloat(speedText.replace(',', '.'))
    if (!Number.isFinite(rotation) || !Number.isFinite(speed)) return []
    return [{ name, direction: normalizedDegrees(rotation - 180), speed }]
  }).slice(0, 2)
}

function updateWind(dashboard) {
  const readings = stationReadings()
  const arrow = dashboard.querySelector('.news-wind-arrow')
  const direction = dashboard.querySelector('.news-wind-copy b')
  const detail = dashboard.querySelector('.news-wind-detail')
  if (readings.length !== 2) {
    arrow.classList.add('is-unavailable')
    arrow.style.setProperty('--wind-rotation', '0deg')
    direction.textContent = '—'
    detail.textContent = copy.noConcurrentReadings
    return
  }

  const sumEast = readings.reduce((sum, reading) => (
    sum + reading.speed * Math.sin(reading.direction * Math.PI / 180)
  ), 0)
  const sumNorth = readings.reduce((sum, reading) => (
    sum + reading.speed * Math.cos(reading.direction * Math.PI / 180)
  ), 0)
  const meanDirection = normalizedDegrees(Math.atan2(sumEast, sumNorth) * 180 / Math.PI)
  const meanSpeed = Math.hypot(sumEast, sumNorth) / readings.length
  arrow.classList.remove('is-unavailable')
  arrow.style.setProperty('--wind-rotation', `${normalizedDegrees(meanDirection + 180)}deg`)
  direction.textContent = cardinal(meanDirection)
  detail.textContent = language === 'de'
    ? `aus ${Math.round(meanDirection)}° · ${meanSpeed.toLocaleString('de-BE', { maximumFractionDigits: 1 })} km/h ${copy.vectorMean}`
    : `from ${Math.round(meanDirection)}° · ${meanSpeed.toLocaleString('en-GB', { maximumFractionDigits: 1 })} km/h ${copy.vectorMean}`
}

function setText(element, value) {
  if (element && element.textContent !== value) element.textContent = value
}

function germanDateLabel(value) {
  return value
    .replace(/\bMar\b/g, 'Mär')
    .replace(/\bMay\b/g, 'Mai')
    .replace(/\bOct\b/g, 'Okt')
    .replace(/\bDec\b/g, 'Dez')
}

function updateLocalizedInterface() {
  setText(document.querySelector('.timeline-title > span'), copy.timeline)
  if (language !== 'de') return
  for (const element of document.querySelectorAll('.map-date-chip span, .timeline-title strong, .timeline-now small')) {
    setText(element, germanDateLabel(element.textContent))
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
  document.documentElement.lang = language
  document.documentElement.dataset.presentation = 'news'
  document.title = copy.documentTitle
  startNewsPresentation()
}
