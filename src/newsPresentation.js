import './news-presentation.css'

const parameters = new URLSearchParams(window.location.search)
const enabled = ['news', 'broadcast'].includes(parameters.get('presentation'))
  || parameters.get('view') === 'news'

function normalizedText(element) {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

function normalizedDegrees(value) {
  return ((value % 360) + 360) % 360
}

function cardinal(degrees) {
  const labels = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  return labels[Math.round(normalizedDegrees(degrees) / 22.5) % labels.length]
}

function newsFeedLimit() {
  const requested = parameters.get('updates')
  if (requested == null) return 5
  const value = Number(requested)
  return Number.isInteger(value) ? Math.max(1, Math.min(10, value)) : 5
}

function dashboardMarkup() {
  return `
    <div class="news-summary">
      <article class="news-stat news-stat--wind">
        <span>Mean observed wind</span>
        <strong class="news-wind-value">
          <i class="news-wind-arrow is-unavailable" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 20V4M6.5 9.5 12 4l5.5 5.5" /></svg>
          </i>
          <i class="news-wind-copy"><b>—</b><em>two nearest stations</em></i>
        </strong>
        <small class="news-wind-sources">Awaiting concurrent observations</small>
      </article>
      <article class="news-stat">
        <span>Announced area</span>
        <strong><b class="news-area-announced">—</b><small class="news-area-announced-unit"></small></strong>
        <small>Official public reports</small>
      </article>
      <article class="news-stat">
        <span>Best estimate</span>
        <strong><b class="news-area-estimated">—</b><small class="news-area-estimated-unit"></small></strong>
        <small>Derived observation outline</small>
      </article>
    </div>
    <section class="news-feed">
      <header class="news-feed-head"><span>Incident updates</span><small>0 sourced</small></header>
      <div class="news-feed-list"><p class="news-update-empty">No sourced update yet</p></div>
    </section>
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
  const detail = dashboard.querySelector('.news-wind-copy em')
  const sources = dashboard.querySelector('.news-wind-sources')
  if (readings.length !== 2) {
    arrow.classList.add('is-unavailable')
    arrow.style.setProperty('--wind-rotation', '0deg')
    direction.textContent = '—'
    detail.textContent = 'two nearest stations'
    sources.textContent = readings.length ? `Only ${readings[0].name} is current` : 'Awaiting concurrent observations'
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
  detail.textContent = `from ${Math.round(meanDirection)}° · ${meanSpeed.toLocaleString('en-GB', { maximumFractionDigits: 1 })} km/h vector mean`
  sources.textContent = readings.map((reading) => reading.name).join(' + ')
}

function updateFeed(dashboard) {
  const events = [...document.querySelectorAll('.event-list .event-item')]
  dashboard.querySelector('.news-feed-head small').textContent = `${events.length} sourced`
  const feed = dashboard.querySelector('.news-feed-list')
  feed.replaceChildren()
  if (!events.length) {
    const empty = document.createElement('p')
    empty.className = 'news-update-empty'
    empty.textContent = 'No sourced update yet'
    feed.append(empty)
    return
  }

  for (const eventNode of events.slice(0, newsFeedLimit())) {
    const copy = eventNode.querySelector('.event-row > span:nth-child(2)')
    const update = document.createElement('article')
    update.className = 'news-update'
    const time = document.createElement('time')
    time.textContent = `${normalizedText(eventNode.querySelector('.event-row time'))} CEST`
    const body = document.createElement('span')
    const title = document.createElement('strong')
    title.textContent = normalizedText(copy?.querySelector('strong'))
    const detail = document.createElement('small')
    detail.textContent = normalizedText(copy?.querySelector('small'))
    body.append(title, detail)
    update.append(time, body)
    feed.append(update)
  }
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
  updateFeed(dashboard)
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
    document.querySelector('button[aria-label="Center on fire"]')?.click()
    scheduleUpdate()
  }, 250)
  scheduleUpdate()
}

if (enabled) {
  document.documentElement.dataset.presentation = 'news'
  document.title = 'High Fens wildfire timeline | Venn Fire Watch'
  startNewsPresentation()
}
