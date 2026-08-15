import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Airplay,
  ArrowDownToLine,
  BadgeAlert,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  CloudSun,
  Database,
  Droplets,
  ExternalLink,
  Eye,
  EyeOff,
  FileUp,
  Flame,
  Gauge,
  Helicopter,
  Info,
  Layers3,
  LocateFixed,
  Map,
  MapPin,
  Maximize2,
  Minus,
  Mountain,
  Pause,
  Plane,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Satellite,
  ShieldAlert,
  Sparkles,
  ThermometerSun,
  Wind,
  X,
} from 'lucide-react'
import MapView from './MapView'
import {
  events,
  effisBurnedArea,
  fireFrames,
  flights,
  initialLayers,
  sourceLinks,
} from './data'

const layerOptions = [
  { key: 'perimeter', label: 'EFFIS fire footprint', detail: '14 Aug daily VIIRS product · ~501 ha', icon: Layers3, color: '#e96838' },
  { key: 'hotspots', label: 'NASA hotspots', detail: 'Only after a FIRMS response', icon: Satellite, color: '#efaa3c' },
  { key: 'aircraft', label: 'Aircraft observations', detail: 'MLAT fixes + photo evidence', icon: Helicopter, color: '#3a7fcc' },
  { key: 'wind', label: 'Wind at Drossart', detail: '10 m hourly model value', icon: Wind, color: '#4f9e90' },
]

const OBSERVATION_RECENCY_MS = 5 * 60 * 1000

function windCardinal(deg) {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  return names[Math.round(deg / 22.5) % 16]
}

function observationState(flight, frame) {
  if (!flight.observations?.length) {
    const visibleEvidence = (flight.evidenceObservations || [])
      .filter((evidence) => evidence.timestampMs <= frame.timestampMs)
    if (flight.evidenceObservations?.length && !visibleEvidence.length) return { key: 'future', label: 'NOT YET' }
    if (visibleEvidence.at(-1)?.state === 'landed') return { key: 'landed', label: 'LANDED PHOTO', latest: visibleEvidence.at(-1) }
    return { key: 'static', label: 'STATIC' }
  }
  const visible = flight.observations.filter((observation) => observation.timestampMs <= frame.timestampMs)
  if (!visible.length) return { key: 'future', label: 'NOT YET' }
  const latest = visible.at(-1)
  if (frame.timestampMs - latest.timestampMs <= OBSERVATION_RECENCY_MS) {
    return { key: 'recent', label: 'OBSERVED', latest }
  }
  return { key: 'past', label: 'LAST SEEN', latest }
}

function iconForEvent(type) {
  if (type === 'satellite') return Satellite
  if (type === 'aircraft') return Helicopter
  if (type === 'wind') return Wind
  if (type === 'area') return Gauge
  if (type === 'closure') return ShieldAlert
  if (type === 'monitor') return Eye
  return Flame
}

function LayerToggle({ item, checked, onChange }) {
  const Icon = item.icon
  return (
    <button
      className={`layer-row ${checked ? 'is-active' : ''}`}
      onClick={onChange}
      type="button"
      aria-pressed={checked}
    >
      <span className="layer-symbol" style={{ '--layer-color': item.color }}>
        <Icon size={16} strokeWidth={1.9} />
      </span>
      <span className="layer-copy">
        <strong>{item.label}</strong>
        <small>{item.detail}</small>
      </span>
      <span className="toggle-track" aria-hidden="true"><i /></span>
    </button>
  )
}

function MiniAreaChart({ currentIndex }) {
  const width = 660
  const height = 44
  const max = 110
  const points = fireFrames.map((frame, index) => {
    const x = (index / (fireFrames.length - 1)) * width
    if (!Number.isFinite(frame.reportedHa)) return null
    const y = height - (frame.reportedHa / max) * (height - 5)
    return [x, y, index]
  }).filter(Boolean)
  const visible = points.filter((point) => point[2] <= currentIndex)
  const path = visible.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = visible.length >= 2 ? `${path} L${visible.at(-1)[0]},${height} L${visible[0][0]},${height} Z` : ''
  const cursorX = (currentIndex / (fireFrames.length - 1)) * width

  return (
    <svg className="mini-area-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="fireAreaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ef7548" stopOpacity="0.36" />
          <stop offset="1" stopColor="#ef7548" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#fireAreaFill)" />
      <path d={path} fill="none" stroke="#ed754a" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <line x1={cursorX} x2={cursorX} y1="0" y2={height} stroke="#263a33" strokeOpacity="0.28" strokeDasharray="2 3" />
    </svg>
  )
}

function Timeline({ frameIndex, setFrameIndex, playing, setPlaying, playbackRate, setPlaybackRate }) {
  const frame = fireFrames[frameIndex]
  const progress = (frameIndex / (fireFrames.length - 1)) * 100
  const visibleEvents = events.filter((event) => event.frame <= frameIndex)

  return (
    <section className="timeline-panel" aria-label="Incident timeline controls">
      <div className="timeline-head">
        <div className="timeline-title">
          <span>Incident timeline</span>
          <strong>14 Aug, 13:00</strong>
          <i />
          <strong>15 Aug, 02:00 CEST</strong>
        </div>
        <div className="timeline-legend">
          <span><i className="legend-line legend-line--fire" />Reported estimate</span>
          <span><i className="legend-dot legend-dot--event" />Incident update</span>
          <span><i className="legend-dot legend-dot--flight" />Aircraft evidence</span>
        </div>
      </div>

      <div className="timeline-body">
        <button className="play-button" onClick={() => setPlaying((value) => !value)} type="button" aria-label={playing ? 'Pause timeline' : 'Play timeline'}>
          {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
        </button>
        <button
          className="step-button"
          onClick={() => setFrameIndex(Math.max(0, frameIndex - 1))}
          type="button"
          aria-label="Previous five minutes"
        >
          <ChevronLeft size={17} />
        </button>

        <div className="timeline-track-wrap">
          <MiniAreaChart currentIndex={frameIndex} />
          <div className="event-markers" aria-hidden="true">
            {events.map((event, index) => (
              <i
                key={`${event.time}-${index}`}
                className={`${event.type === 'aircraft' ? 'is-flight' : ''} ${event.frame <= frameIndex ? 'is-past' : ''}`}
                style={{ left: `${(event.frame / (fireFrames.length - 1)) * 100}%` }}
              />
            ))}
          </div>
          <input
            className="timeline-range"
            type="range"
            min="0"
            max={fireFrames.length - 1}
            step="1"
            value={frameIndex}
            onChange={(event) => {
              setPlaying(false)
              setFrameIndex(Number(event.target.value))
            }}
            style={{ '--timeline-progress': `${progress}%` }}
            aria-label="Incident time"
          />
          <div className="timeline-ticks" aria-hidden="true">
            <span>13:00</span>
            <span>16:00</span>
            <span>19:00</span>
            <span>22:00</span>
            <span>01:00</span>
          </div>
          <div className="timeline-now" style={{ left: `${progress}%` }}>
            <strong>{frame.shortTime}</strong>
            <small>{frame.dayLabel}</small>
          </div>
        </div>

        <button
          className="step-button"
          onClick={() => setFrameIndex(Math.min(fireFrames.length - 1, frameIndex + 1))}
          type="button"
          aria-label="Next five minutes"
        >
          <ChevronRight size={17} />
        </button>
        <button
          className="speed-button"
          onClick={() => setPlaybackRate((value) => value === 1 ? 2 : value === 2 ? 4 : 1)}
          type="button"
          aria-label="Change playback speed"
        >
          {playbackRate}×
        </button>
      </div>

      <div className="timeline-foot">
        <span><Radio size={12} /> Five-minute timeline · {visibleEvents.length} sourced updates visible</span>
        <span className="reconstruction-note"><Info size={12} /> Dashed aircraft links join only plausible adjacent fixes; gaps stay open. Icons appear only within five minutes of a fix.</span>
        <a className="apyos-credit" href="https://apyos.com" target="_blank" rel="noreferrer">
          Developed by <strong>Apyos</strong><ExternalLink size={11} />
        </a>
      </div>
    </section>
  )
}

function SourceMark({ tone }) {
  if (tone === 'nasa') return <span className="source-monogram source-monogram--nasa">NASA</span>
  if (tone === 'effis') return <span className="source-monogram source-monogram--effis">EU</span>
  if (tone === 'weather') return <span className="source-monogram source-monogram--weather"><CloudSun size={17} /></span>
  if (tone === 'rmi') return <span className="source-monogram source-monogram--rmi">RMI</span>
  return <span className="source-monogram source-monogram--adsb"><Airplay size={17} /></span>
}

function DataModal({ open, onClose, onImportTracks, importedCount, onFirmsData, connectedCount }) {
  const [tab, setTab] = useState('connections')
  const [mapKey, setMapKey] = useState(() => localStorage.getItem('venn-firms-key') || '')
  const [keyVisible, setKeyVisible] = useState(false)
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const closeOnEscape = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open, onClose])

  async function testFirms() {
    if (!mapKey.trim()) {
      setStatus('error')
      setMessage('Add your free FIRMS MAP_KEY first.')
      return
    }
    localStorage.setItem('venn-firms-key', mapKey.trim())
    setStatus('loading')
    setMessage('Checking the FIRMS area service…')
    const endpoint = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey.trim()}/VIIRS_SNPP_NRT/5.90,50.50,6.16,50.66/2/2026-08-14`
    try {
      const response = await fetch(endpoint)
      if (!response.ok) throw new Error(`FIRMS returned ${response.status}`)
      const csv = await response.text()
      const rows = csv.trim().split(/\r?\n/)
      const headers = (rows.shift() || '').split(',').map((value) => value.trim().toLowerCase())
      const indexOf = (...names) => headers.findIndex((value) => names.includes(value))
      const latitudeIndex = indexOf('latitude')
      const longitudeIndex = indexOf('longitude')
      const dateIndex = indexOf('acq_date')
      const timeIndex = indexOf('acq_time')
      const confidenceIndex = indexOf('confidence')
      const frpIndex = indexOf('frp')
      const instrumentIndex = indexOf('instrument')
      const satelliteIndex = indexOf('satellite')
      if (latitudeIndex < 0 || longitudeIndex < 0) throw new Error('FIRMS response did not contain coordinates')

      const detections = rows.map((row) => {
        const cells = row.split(',').map((value) => value.trim())
        const latitude = Number(cells[latitudeIndex])
        const longitude = Number(cells[longitudeIndex])
        const rawTime = (cells[timeIndex] || '0000').padStart(4, '0')
        const acquired = `${cells[dateIndex] || '2026-08-14'}T${rawTime.slice(0, 2)}:${rawTime.slice(2, 4)}:00Z`
        const acquiredAt = new Date(acquired).getTime()
        let closestFrame = 0
        let closestDistance = Number.POSITIVE_INFINITY
        fireFrames.forEach((item, index) => {
          const distance = Math.abs(new Date(item.time).getTime() - acquiredAt)
          if (distance < closestDistance) {
            closestDistance = distance
            closestFrame = index
          }
        })
        return {
          position: [latitude, longitude],
          frame: closestFrame,
          confidence: (cells[confidenceIndex] || 'nominal').toLowerCase(),
          sensor: `${cells[satelliteIndex] || 'VIIRS'} ${cells[instrumentIndex] || ''}`.trim(),
          frp: Number(cells[frpIndex]) || null,
          acquired: acquired.replace('T', ' ').replace(':00Z', ' UTC'),
          connected: true,
        }
      }).filter((spot) => Number.isFinite(spot.position[0]) && Number.isFinite(spot.position[1]))

      onFirmsData(detections)
      setStatus('success')
      setMessage(`${detections.length} VIIRS records returned and plotted for the map extent.`)
    } catch (error) {
      setStatus('error')
      setMessage(`${error.message}. The key was saved; a server proxy may be needed if the browser blocks CORS.`)
    }
  }

  async function importFile(file) {
    if (!file) return
    try {
      const text = await file.text()
      let tracks = []
      if (file.name.toLowerCase().endsWith('.csv')) {
        const lines = text.trim().split(/\r?\n/)
        const headers = lines.shift().split(',').map((item) => item.trim().toLowerCase())
        const latIndex = headers.findIndex((value) => ['lat', 'latitude'].includes(value))
        const lonIndex = headers.findIndex((value) => ['lon', 'lng', 'longitude'].includes(value))
        const callIndex = headers.findIndex((value) => ['callsign', 'call_sign', 'flight', 'registration'].includes(value))
        if (latIndex < 0 || lonIndex < 0) throw new Error('CSV needs latitude and longitude columns')
        const groups = new Map()
        lines.forEach((line) => {
          const cells = line.split(',').map((item) => item.trim())
          const callSign = callIndex >= 0 ? cells[callIndex] || 'IMPORTED' : 'IMPORTED'
          const point = [Number(cells[latIndex]), Number(cells[lonIndex])]
          if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return
          if (!groups.has(callSign)) groups.set(callSign, [])
          groups.get(callSign).push(point)
        })
        tracks = [...groups.entries()].map(([callSign, points], index) => ({ callSign, points, index }))
      } else {
        const json = JSON.parse(text)
        const features = json.type === 'FeatureCollection' ? json.features : [json]
        tracks = features
          .filter((feature) => (feature.geometry || feature).type === 'LineString')
          .map((feature, index) => {
            const geometry = feature.geometry || feature
            return {
              callSign: feature.properties?.callsign || feature.properties?.flight || `IMPORT ${index + 1}`,
              points: geometry.coordinates.map(([lon, lat]) => [lat, lon]),
              index,
            }
          })
      }
      if (!tracks.length) throw new Error('No usable LineString or coordinate rows found')
      onImportTracks(tracks)
      setStatus('success')
      setMessage(`${tracks.length} aircraft track${tracks.length === 1 ? '' : 's'} imported into the map.`)
    } catch (error) {
      setStatus('error')
      setMessage(error.message)
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  if (!open) return null

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="data-modal" role="dialog" aria-modal="true" aria-labelledby="data-modal-title">
        <header className="modal-header">
          <div>
            <span className="kicker">DATA WORKSPACE</span>
            <h2 id="data-modal-title">Sources & connections</h2>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Close data workspace"><X size={19} /></button>
        </header>

        <nav className="modal-tabs" aria-label="Data workspace sections">
          <button className={tab === 'connections' ? 'is-active' : ''} onClick={() => setTab('connections')} type="button">Connections</button>
          <button className={tab === 'method' ? 'is-active' : ''} onClick={() => setTab('method')} type="button">Method & limits</button>
          <button className={tab === 'sources' ? 'is-active' : ''} onClick={() => setTab('sources')} type="button">Source directory</button>
        </nav>

        <div className="modal-content">
          {tab === 'connections' && (
            <>
              <div className="connection-card connection-card--primary">
                <div className="connection-icon"><Satellite size={20} /></div>
                <div className="connection-copy">
                  <div className="connection-title"><strong>NASA FIRMS</strong><span className={`status-pill ${connectedCount ? 'status-pill--connected' : 'status-pill--key'}`}>{connectedCount ? <><Check size={11} /> {connectedCount} plotted</> : 'MAP_KEY required'}</span></div>
                  <p>Query VIIRS S-NPP detections inside the Eupen–High Fens map extent. The key is stored only in this browser.</p>
                  <div className="key-input">
                    <input
                      type={keyVisible ? 'text' : 'password'}
                      value={mapKey}
                      onChange={(event) => setMapKey(event.target.value)}
                      placeholder="Paste your free FIRMS MAP_KEY"
                      autoComplete="off"
                    />
                    <button type="button" onClick={() => setKeyVisible((value) => !value)} aria-label={keyVisible ? 'Hide map key' : 'Show map key'}>{keyVisible ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                    <button className="connect-button" onClick={testFirms} type="button" disabled={status === 'loading'}>{status === 'loading' ? 'Checking…' : 'Save & test'}</button>
                  </div>
                  <a className="inline-link" href="https://firms.modaps.eosdis.nasa.gov/api/map_key/" target="_blank" rel="noreferrer">Request a free key <ExternalLink size={12} /></a>
                </div>
              </div>

              <div className="connection-grid">
                <button className="connection-card connection-card--upload" onClick={() => inputRef.current?.click()} type="button">
                  <span className="connection-icon"><FileUp size={20} /></span>
                  <span className="connection-copy">
                    <span className="connection-title"><strong>Import aircraft tracks</strong><span className="status-pill">{importedCount || 0} loaded</span></span>
                    <p>GeoJSON LineString or CSV with latitude, longitude and an optional callsign. Untimed files are displayed as static geometry.</p>
                    <span className="upload-cta">Choose a file <ArrowDownToLine size={14} /></span>
                  </span>
                </button>
                <input ref={inputRef} hidden type="file" accept=".json,.geojson,.csv,application/json,text/csv" onChange={(event) => importFile(event.target.files?.[0])} />

                <div className="connection-card">
                  <span className="connection-icon connection-icon--weather"><Wind size={20} /></span>
                  <span className="connection-copy">
                    <span className="connection-title"><strong>Local weather</strong><span className="status-pill status-pill--connected"><Check size={11} /> Seeded</span></span>
                    <p>Hourly 10 m wind, gust, temperature and humidity for the Drossart model grid point at 50.548° N, 6.061° E.</p>
                    <span className="connection-meta">Open-Meteo · Europe/Brussels</span>
                  </span>
                </div>
              </div>

              {message && (
                <div className={`connection-message is-${status}`}>
                  {status === 'success' ? <Check size={15} /> : status === 'error' ? <BadgeAlert size={15} /> : <Activity size={15} />}
                  <span>{message}</span>
                </div>
              )}
            </>
          )}

          {tab === 'method' && (
            <div className="method-layout">
              <div className="method-callout">
                <Info size={19} />
                <p><strong>Different products answer different questions.</strong> The viewer keeps reported area, satellite-derived geometry, thermal detections, aircraft fixes and model weather separate.</p>
              </div>
              <div className="method-steps">
                <article><span>01</span><div><strong>Thermal anomaly</strong><p>No marker is bundled. If FIRMS returns VIIRS data, each point remains a sensor observation rather than a burned-area polygon.</p></div></article>
                <article><span>02</span><div><strong>Reported area</strong><p>The ~100 ha figure appears only from the cited reporting time and is never converted into a drawn shape.</p></div></article>
                <article><span>03</span><div><strong>Satellite footprint</strong><p>The ~501 ha map shape is the real 14 August EFFIS VIIRS-derived polygon. It is a static daily algorithmic footprint, not a surveyed perimeter or five-minute progression.</p></div></article>
                <article><span>04</span><div><strong>Aircraft observations</strong><p>G10 is shown as individual MLAT fixes. Gaps stay empty, and a marker never claims the helicopter remained airborne.</p></div></article>
              </div>
              <div className="safety-note"><ShieldAlert size={17} /><span>This viewer is informational and must not be used for evacuation or preservation-of-life decisions. Follow BE-Alert and emergency services.</span></div>
            </div>
          )}

          {tab === 'sources' && (
            <div className="source-directory">
              {sourceLinks.map((source) => (
                <a key={source.name} href={source.url} target="_blank" rel="noreferrer" className="directory-row">
                  <SourceMark tone={source.tone} />
                  <span><strong>{source.name}</strong><small>{source.detail}</small></span>
                  <em>{source.cadence}</em>
                  <ExternalLink size={15} />
                </a>
              ))}
              <div className="source-footnote"><CircleHelp size={15} /><p>A production deployment should proxy credentialed APIs server-side, archive raw responses with timestamps and expose provenance on every observation.</p></div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function App() {
  const [frameIndex, setFrameIndex] = useState(fireFrames.length - 1)
  const [layers, setLayers] = useState(initialLayers)
  const [baseMode, setBaseMode] = useState('terrain')
  const [playing, setPlaying] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [inspectorTab, setInspectorTab] = useState('situation')
  const [dataOpen, setDataOpen] = useState(false)
  const [mapActions, setMapActions] = useState(null)
  const [mobileLayersOpen, setMobileLayersOpen] = useState(false)
  const [importedTracks, setImportedTracks] = useState([])
  const [connectedHotspots, setConnectedHotspots] = useState([])
  const frame = fireFrames[frameIndex]
  const reportedAreaText = frame.reportedHa == null ? '—' : `~${frame.reportedHa}`

  useEffect(() => {
    if (!playing) return undefined
    const delay = 1100 / playbackRate
    const timer = window.setInterval(() => {
      setFrameIndex((current) => {
        if (current >= fireFrames.length - 1) {
          setPlaying(false)
          return current
        }
        return current + 1
      })
    }, delay)
    return () => window.clearInterval(timer)
  }, [playing, playbackRate])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (dataOpen || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return
      if (event.key === 'ArrowLeft') setFrameIndex((value) => Math.max(0, value - 1))
      if (event.key === 'ArrowRight') setFrameIndex((value) => Math.min(fireFrames.length - 1, value + 1))
      if (event.key === ' ') {
        event.preventDefault()
        setPlaying((value) => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dataOpen])

  const currentEvents = useMemo(
    () => events.filter((event) => event.frame <= frameIndex).slice(-5).reverse(),
    [frameIndex],
  )

  const activeFlights = useMemo(
    () => flights.filter((flight) => observationState(flight, frame).key === 'recent'),
    [frame],
  )

  const visibleHotspots = connectedHotspots.filter((spot) => spot.frame <= frameIndex).length

  function importTracks(tracks) {
    const colors = ['#168aad', '#c15f9a', '#7c9f35', '#d47f28']
    const normalized = tracks.map((track, index) => ({
      id: `import-${Date.now()}-${index}`,
      callSign: track.callSign,
      label: 'Imported aircraft track',
      type: 'helicopter',
      status: 'Static user import · no timestamp or airborne status inferred',
      color: colors[index % colors.length],
      start: null,
      end: null,
      drops: null,
      distance: null,
      points: track.points,
    }))
    setImportedTracks((current) => [...current, ...normalized])
    setLayers((current) => ({ ...current, aircraft: true }))
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-mark"><Flame size={19} fill="currentColor" /></span>
          <div><strong>VENN</strong><small>FIRE WATCH</small></div>
        </div>

        <div className="incident-heading">
          <div className="incident-location"><MapPin size={14} /><span>HIGH FENS</span><i>/</i><b>EUPEN · BAELEN</b></div>
          <span className="reference-badge"><Sparkles size={11} /> OBSERVATION VIEW</span>
        </div>

        <div className="header-actions">
          <div className="updated-state"><span className="live-pulse" /><div><small>DATA SNAPSHOT</small><strong>15 Aug · 02:00 CEST</strong></div></div>
          <button className="data-button" type="button" onClick={() => setDataOpen(true)}><Database size={15} /><span>Data & sources</span></button>
        </div>
      </header>

      <div className="workspace">
        <aside className={`left-sidebar ${mobileLayersOpen ? 'is-mobile-open' : ''}`}>
          <div className="incident-card">
            <div className="incident-card-head">
              <span className="active-tag"><i /> INCIDENT RECORD</span>
              <button type="button" aria-label="Incident information"><Info size={15} /></button>
            </div>
            <h1>High Fens<br />wildfire</h1>
            <p>Drossart · Fagne des Deux-Séries</p>
            <div className="incident-metrics">
              <div><strong>{reportedAreaText}</strong><span>reported hectares</span><small>{frame.areaLabel}</small></div>
              <div><strong>~{Math.round(effisBurnedArea.areaHa)}</strong><span>EFFIS footprint ha</span><small>static 14 Aug product</small></div>
            </div>
          </div>

          <div className="sidebar-section layers-section">
            <div className="section-heading"><span>MAP LAYERS</span><button type="button" onClick={() => setLayers(initialLayers)} aria-label="Reset map layers"><RotateCcw size={13} /></button></div>
            <div className="layer-list">
              {layerOptions.map((item) => (
                <LayerToggle
                  key={item.key}
                  item={item}
                  checked={layers[item.key]}
                  onChange={() => setLayers((value) => ({ ...value, [item.key]: !value[item.key] }))}
                />
              ))}
            </div>
          </div>

          <div className="sidebar-section source-summary">
            <div className="section-heading"><span>SOURCE HEALTH</span><button type="button" onClick={() => setDataOpen(true)}>Manage</button></div>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="nasa" /><span><strong>FIRMS</strong><small>{connectedHotspots.length ? `${connectedHotspots.length} detections plotted` : 'No data loaded'}</small></span><em className={`health-dot ${connectedHotspots.length ? '' : 'health-dot--amber'}`} />
            </button>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="effis" /><span><strong>EFFIS footprint</strong><small>14 Aug VIIRS daily polygon</small></span><em className="health-dot" />
            </button>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="weather" /><span><strong>Wind model</strong><small>Drossart hourly values</small></span><em className="health-dot" />
            </button>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="adsb" /><span><strong>Aircraft</strong><small>{flights.length} sourced set{importedTracks.length ? ` · ${importedTracks.length} static import` : ''}</small></span><em className="health-dot" /></button>
          </div>

          <div className="emergency-note">
            <ShieldAlert size={17} />
            <p><strong>Not an emergency service</strong><span>For official instructions follow BE-Alert and call 112 only for an emergency.</span></p>
          </div>
        </aside>

        <main className="map-region">
          <MapView
            frameIndex={frameIndex}
            layers={layers}
            baseMode={baseMode}
            onMapReady={setMapActions}
            importedTracks={importedTracks}
            connectedHotspots={connectedHotspots}
          />

          <div className="map-topbar">
            <button className="mobile-layer-button" type="button" onClick={() => setMobileLayersOpen((value) => !value)}><Layers3 size={16} /> Layers</button>
            <div className="basemap-switcher" role="group" aria-label="Base map">
              <button className={baseMode === 'terrain' ? 'is-active' : ''} onClick={() => setBaseMode('terrain')} type="button"><Map size={14} /> Map</button>
              <button className={baseMode === 'satellite' ? 'is-active' : ''} onClick={() => setBaseMode('satellite')} type="button"><Satellite size={14} /> Satellite</button>
              <button className={baseMode === 'topo' ? 'is-active' : ''} onClick={() => setBaseMode('topo')} type="button"><Mountain size={14} /> Topo</button>
            </div>
            <div className="map-date-chip"><CalendarDays size={14} /><span>{frame.dayLabel === '14 AUG' ? 'Fri 14 Aug' : 'Sat 15 Aug'}</span><strong>{frame.shortTime}</strong></div>
          </div>

          <div className="map-warning">
            <ShieldAlert size={15} />
            <p><strong>Official instructions take precedence</strong><span>This historical viewer does not determine current access or safety.</span></p>
            <a href="https://www.be-alert.be/en" target="_blank" rel="noreferrer">BE-Alert <ExternalLink size={12} /></a>
          </div>

          <div className="map-controls" aria-label="Map controls">
            <button type="button" onClick={() => mapActions?.zoomIn()} aria-label="Zoom in"><Plus size={18} /></button>
            <button type="button" onClick={() => mapActions?.zoomOut()} aria-label="Zoom out"><Minus size={18} /></button>
            <i />
            <button type="button" onClick={() => mapActions?.home()} aria-label="Show full incident area"><Maximize2 size={17} /></button>
            <button type="button" onClick={() => mapActions?.fire()} aria-label="Center on fire"><LocateFixed size={17} /></button>
          </div>

          <div className="map-scale-card"><span><i /> 5 km</span><small>50.548° N · 6.058° E</small></div>

          <Timeline
            frameIndex={frameIndex}
            setFrameIndex={setFrameIndex}
            playing={playing}
            setPlaying={setPlaying}
            playbackRate={playbackRate}
            setPlaybackRate={setPlaybackRate}
          />
        </main>

        <aside className="right-inspector">
          <div className="inspector-tabs">
            <button className={inspectorTab === 'situation' ? 'is-active' : ''} onClick={() => setInspectorTab('situation')} type="button">Situation</button>
            <button className={inspectorTab === 'air' ? 'is-active' : ''} onClick={() => setInspectorTab('air')} type="button">Air ops <span>{flights.length + importedTracks.length}</span></button>
          </div>

          {inspectorTab === 'situation' ? (
            <div className="inspector-scroll">
              <div className="snapshot-head">
                <span className="kicker">AT SELECTED TIME</span>
                <strong>{frame.shortTime}<small>CEST</small></strong>
                <p>{frame.dateLabel}</p>
              </div>

              <div className="snapshot-grid">
                <article className="snapshot-card snapshot-card--fire"><span><Flame size={15} /> REPORTED AREA</span><strong>{reportedAreaText}<small>{frame.reportedHa == null ? '' : 'ha'}</small></strong><p>{frame.areaLabel}</p></article>
                <article className="snapshot-card snapshot-card--effis"><span><Layers3 size={15} /> EFFIS FOOTPRINT</span><strong>~{Math.round(effisBurnedArea.areaHa)}<small>ha</small></strong><p>static 14 Aug VIIRS geometry</p></article>
                <article className="snapshot-card"><span><Satellite size={15} /> HOTSPOTS</span><strong>{visibleHotspots}<small>pts</small></strong><p>{connectedHotspots.length ? 'NASA FIRMS connected' : 'no FIRMS data loaded'}</p></article>
                <article className="snapshot-card"><span><Helicopter size={15} /> AIRCRAFT</span><strong>{activeFlights.length}<small>recent</small></strong><p>{activeFlights.length ? 'fix within previous 5 min' : 'no recent observation'}</p></article>
                <article className="snapshot-card snapshot-card--wind"><span><Wind size={15} /> WIND FROM</span><strong>{windCardinal(frame.windDirection)}<small>{frame.windDirection}°</small></strong><p>{frame.windSpeed.toFixed(1)} km/h · gust {frame.gust.toFixed(0)}</p></article>
              </div>

              <div className="conditions-card">
                <div className="section-heading"><span>FIRE WEATHER</span><small>10 m · hourly model</small></div>
                <div className="wind-hero">
                  <span className="big-wind-arrow" title={`Wind travelling toward ${(frame.windDirection + 180) % 360}°`}>
                    <svg viewBox="0 0 24 24" style={{ '--wind-rotation': `${(frame.windDirection + 180) % 360}deg` }} aria-hidden="true">
                      <path d="M12 20V4M6.5 9.5 12 4l5.5 5.5" />
                    </svg>
                  </span>
                  <div><strong>{windCardinal(frame.windDirection)}</strong><span>from {frame.windDirection}° · arrow toward {(frame.windDirection + 180) % 360}°</span></div>
                  <p><strong>{frame.windSpeed.toFixed(1)}</strong><span>km/h</span><small>gusts {frame.gust.toFixed(1)}</small></p>
                </div>
                <div className="condition-row">
                  <span><ThermometerSun size={15} /> Temperature<strong>{frame.temperature.toFixed(1)}°C</strong></span>
                  <span><Droplets size={15} /> Humidity<strong>{frame.humidity}%</strong></span>
                </div>
              </div>

              <section className="event-log">
                <div className="section-heading"><span>INCIDENT LOG</span><small>{events.filter((event) => event.frame <= frameIndex).length} visible</small></div>
                <div className="event-list">
                  {currentEvents.map((event, index) => {
                    const Icon = iconForEvent(event.type)
                    return (
                      <button key={`${event.time}-${event.title}`} className={`event-row ${index === 0 ? 'is-latest' : ''}`} type="button" onClick={() => setFrameIndex(event.frame)}>
                        <span className={`event-icon event-icon--${event.type}`}><Icon size={14} /></span>
                        <span><strong>{event.title}</strong><small>{event.detail}</small></span>
                        <time>{event.time}</time>
                      </button>
                    )
                  })}
                </div>
              </section>
            </div>
          ) : (
            <div className="inspector-scroll air-ops-panel">
              <div className="air-ops-summary">
                <span className="kicker">TRACK COVERAGE</span>
                <h2>Aerial operations</h2>
                <p>Two police helicopters are confirmed: G10 by photo and MLAT, G12 by a timestamped landed photo. Only G10 has an incident-area receiver path.</p>
                <button type="button" onClick={() => setDataOpen(true)}><FileUp size={14} /> Import tracks</button>
              </div>

              <div className="flight-list">
                {[...flights, ...importedTracks].map((flight) => {
                  const state = observationState(flight, frame)
                  const isActive = state.key === 'recent'
                  const hasStarted = !['future'].includes(state.key)
                  const observationCount = flight.observations?.length ?? null
                  const coverageCount = flight.coverageWindows?.length ?? null
                  const photoCount = flight.evidenceObservations?.filter((evidence) => evidence.kind === 'photo').length ?? 0
                  return (
                    <article key={flight.id} className={`flight-card ${isActive ? 'is-active' : ''} ${hasStarted ? '' : 'is-future'}`}>
                      <div className="flight-head">
                        <span className="flight-icon" style={{ '--flight-color': flight.color }}>{flight.type === 'plane' ? <Plane size={17} /> : <Helicopter size={17} />}</span>
                        <div><strong>{flight.callSign}</strong><small>{flight.label}</small></div>
                        <span className={`flight-state ${isActive ? 'is-live' : ''}`}>{state.label}</span>
                      </div>
                      <div className="flight-stats"><span><small>FIXES</small><strong>{observationCount ?? '—'}</strong></span><span><small>CLUSTERS</small><strong>{coverageCount ?? '—'}</strong></span><span><small>PHOTOS</small><strong>{photoCount || '—'}</strong></span></div>
                      <div className="flight-provenance"><Info size={12} /> {flight.status}{flight.pathMethod ? ` · ${flight.pathMethod}` : ''}</div>
                    </article>
                  )
                })}
              </div>

              <div className="coverage-note"><Radio size={15} /><p><strong>G12 is confirmed, but untracked here.</strong><span>A timestamped BRF photo visibly shows it landed. Its absence from receiver archives does not mean it did not fly.</span></p></div>
            </div>
          )}
        </aside>
      </div>

      <DataModal
        open={dataOpen}
        onClose={() => setDataOpen(false)}
        onImportTracks={importTracks}
        importedCount={importedTracks.length}
        onFirmsData={setConnectedHotspots}
        connectedCount={connectedHotspots.length}
      />
    </div>
  )
}

export default App
