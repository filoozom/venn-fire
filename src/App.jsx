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
  buildFireFrames,
  bundledWeatherRows,
  dwdWindStations,
  events,
  effisAreaForTimestamp,
  fireFrames,
  FIVE_MINUTES_MS,
  flights,
  incidentAircraftMeta,
  initialLayers,
  nearbyTrafficMeta,
  normalizeNearbyTrafficSnapshot,
  sourceLinks,
  TIMELINE_START_MS,
} from './data'
import { FIRMS_SENSORS, estimateFootprintArea } from './firmsDetections'

// Each sensor is its own layer and each confidence level its own filter, so the
// viewer chooses the configuration rather than inheriting a threshold we picked.
// The hectare figure recomputes from whatever is checked; it is never a stored
// constant.
const FIRMS_LAYER_KEYS = Object.fromEntries(FIRMS_SENSORS.map((sensor) => [sensor.key, `firms:${sensor.key}`]))
const FIRMS_CONFIDENCE_LEVELS = [
  { key: 'firmsConfidence:high', level: 'high', label: 'High confidence' },
  { key: 'firmsConfidence:nominal', level: 'nominal', label: 'Nominal confidence' },
  { key: 'firmsConfidence:low', level: 'low', label: 'Low confidence' },
]

// A MODIS pixel on these overpasses averaged around 500 ha, which is more than
// half the reported fire. Its detections are shown; no hectare figure is derived
// from them, because a number at that pixel size carries no information.
const AREA_CAPABLE_SENSORS = new Set(['viirsSnpp', 'viirsNoaa20', 'viirsNoaa21'])

const FIRMS_LAYER_DEFAULTS = {
  ...Object.fromEntries(FIRMS_SENSORS.map((sensor) => [FIRMS_LAYER_KEYS[sensor.key], sensor.key !== 'modis'])),
  'firmsConfidence:high': true,
  'firmsConfidence:nominal': true,
  'firmsConfidence:low': false,
}

const DWD_WIND_LAYER_KEYS = Object.fromEntries(
  dwdWindStations.map((station) => [station.id, `dwdWind:${station.id}`]),
)
const DWD_WIND_LAYER_DEFAULTS = Object.fromEntries(
  dwdWindStations.map((station) => [DWD_WIND_LAYER_KEYS[station.id], true]),
)
const INITIAL_LAYER_STATE = { ...initialLayers, ...FIRMS_LAYER_DEFAULTS, ...DWD_WIND_LAYER_DEFAULTS }
const FIRMS_REFRESH_MS = 15 * 60 * 1000
const EMPTY_FIRMS_DATA = {
  schemaVersion: 1,
  generatedAt: null,
  locationReference: {
    name: 'Drossart locality',
    latitude: 50.54762,
    longitude: 6.05757,
  },
  sensors: [],
  detections: [],
}

function firmsDetectionKey(detection) {
  return [
    detection.sensorKey,
    detection.acquiredAt,
    Number(detection.latitude).toFixed(6),
    Number(detection.longitude).toFixed(6),
  ].join('|')
}

// Live responses cover a rolling window. Merge them into the audited snapshot
// rather than replacing history, and prefer live fields only for exact duplicate
// observations.
function mergeFirmsData(bundled, live) {
  const detections = new Map(
    bundled.detections.map((detection) => [firmsDetectionKey(detection), detection]),
  )
  live.detections.forEach((detection) => detections.set(firmsDetectionKey(detection), detection))

  const sensorSummaries = new Map(
    bundled.sensors.map((summary) => [summary.sensorKey, summary]),
  )
  live.sensors.forEach((summary) => sensorSummaries.set(summary.sensorKey, summary))

  return {
    ...bundled,
    ...live,
    locationReference: live.locationReference || bundled.locationReference,
    sensors: FIRMS_SENSORS.flatMap((sensor) => {
      const summary = sensorSummaries.get(sensor.key)
      return summary ? [summary] : []
    }),
    detections: [...detections.values()].sort((left, right) => (
      Date.parse(left.acquiredAt) - Date.parse(right.acquiredAt)
      || left.sensorKey.localeCompare(right.sensorKey)
    )),
  }
}

function layerOptionsFor(effisArea, isCarriedForward, firmsSummaries = [], frame = null) {
  return [
  { key: 'perimeter', label: 'EFFIS daily geometry', detail: effisArea ? `${effisArea.productDate}${isCarriedForward ? ' carried forward' : ''} · ${Math.round(effisArea.areaHa).toLocaleString('en-GB')} ha polygon` : 'No product available at selected time', icon: Layers3, color: '#e96838' },
  ...FIRMS_SENSORS.map((sensor) => {
    const summary = firmsSummaries.find((entry) => entry.sensorKey === sensor.key)
    const pixel = summary?.meanPixelHa
    return {
      key: FIRMS_LAYER_KEYS[sensor.key],
      label: sensor.name,
      detail: summary
        ? `${summary.detectionCount} detections · ${pixel ? `${Math.round(pixel)} ha mean pixel` : `${sensor.nominalResolutionM} m nominal`}${AREA_CAPABLE_SENSORS.has(sensor.key) ? '' : ' · no area derived'}`
        : 'No detections in the bundled snapshot',
      icon: Satellite,
      color: sensor.color,
    }
  }),
  { key: 'aircraft', label: 'Aircraft observations', detail: 'Exact MLAT dots + gap-limited connectors', icon: Helicopter, color: '#3a7fcc' },
  { key: 'traffic', label: 'All nearby receiver traffic', detail: `${nearbyTrafficMeta.aircraftCount} other identifiers · optional`, icon: Radio, color: '#687e8a' },
  { key: 'wind', label: 'Drossart model wind', detail: frame?.drossartWind ? `Open-Meteo hourly grid · ${frame.drossartWind.ageMinutes} min old` : 'No model value at selected time', icon: Wind, color: '#478fc4' },
  { key: 'rmiWind', label: 'Mont Rigi station wind', detail: frame?.montRigiWind ? `RMI 10 min observation · ${frame.montRigiWind.ageMinutes} min old · awaiting validation` : 'No station observation within 20 min of selected time', icon: Wind, color: '#4f9e90' },
  ...dwdWindStations.map((station) => {
    const reading = frame?.dwdWinds?.find((item) => item.id === station.id)
    return {
      key: DWD_WIND_LAYER_KEYS[station.id],
      label: `${station.name} wind`,
      detail: reading ? `DWD 10 min · ${station.distanceKm.toFixed(1)} km away · ${reading.ageMinutes} min old · preliminary` : 'No DWD reading within 90 min of selected time',
      icon: Wind,
      color: '#a58ad4',
    }
  }),
  ]
}

const OBSERVATION_RECENCY_MS = 5 * 60 * 1000

function windCardinal(deg) {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  return names[Math.round(deg / 22.5) % 16]
}

function localClock(timestamp) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Brussels',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
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

function MiniAreaChart({ currentIndex, frames }) {
  const width = 660
  const height = 44
  const reportedValues = frames.map((frame) => frame.reportedHa).filter(Number.isFinite)
  const max = Math.max(1, ...reportedValues) * 1.12
  const points = frames.map((frame, index) => {
    if (frame.reportedHa === frames[index - 1]?.reportedHa) return null
    const x = (index / (frames.length - 1)) * width
    if (!Number.isFinite(frame.reportedHa)) return null
    const y = height - (frame.reportedHa / max) * (height - 5)
    return [x, y, index]
  }).filter(Boolean)
  const visible = points.filter((point) => point[2] <= currentIndex)
  const cursorX = (currentIndex / (frames.length - 1)) * width
  const path = visible.length
    ? `${visible.reduce((result, [x, y], index) => (
      index === 0
        ? `M${x.toFixed(1)},${y.toFixed(1)}`
        : `${result} H${x.toFixed(1)} V${y.toFixed(1)}`
    ), '')} H${cursorX.toFixed(1)}`
    : ''
  const area = visible.length
    ? `${path} L${cursorX.toFixed(1)},${height} L${visible[0][0].toFixed(1)},${height} Z`
    : ''

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

function Timeline({ frames, frameIndex, setFrameIndex, playing, setPlaying, playbackRate, setPlaybackRate }) {
  const frame = frames[frameIndex]
  const progress = (frameIndex / (frames.length - 1)) * 100
  const visibleEvents = events.filter((event) => event.frame <= frameIndex)
  const timelineTicks = Array.from({ length: 5 }, (_, index) => (
    frames[Math.round((index / 4) * (frames.length - 1))]
  ))

  return (
    <section className="timeline-panel" aria-label="Incident timeline controls">
      <div className="timeline-head">
        <div className="timeline-title">
          <span>Incident timeline</span>
          <strong>{frames[0].dayLabel.replace(/^0/, '')}, {frames[0].shortTime}</strong>
          <i />
          <strong>{frames.at(-1).dayLabel.replace(/^0/, '')}, {frames.at(-1).shortTime} CEST</strong>
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
          <MiniAreaChart currentIndex={frameIndex} frames={frames} />
          <div className="event-markers" aria-hidden="true">
            {events.filter((event) => event.frame < frames.length).map((event, index) => (
              <i
                key={`${event.time}-${index}`}
                className={`${event.type === 'aircraft' ? 'is-flight' : ''} ${event.frame <= frameIndex ? 'is-past' : ''}`}
                style={{ left: `${(event.frame / (frames.length - 1)) * 100}%` }}
              />
            ))}
          </div>
          <input
            className="timeline-range"
            type="range"
            min="0"
            max={frames.length - 1}
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
            {timelineTicks.map((tick, index) => <span key={`${tick.time}-${index}`}>{tick.shortTime}</span>)}
          </div>
          <div className="timeline-now" style={{ left: `${progress}%` }}>
            <strong>{frame.shortTime}</strong>
            <small>{frame.dayLabel}</small>
          </div>
        </div>

        <button
          className="step-button"
          onClick={() => setFrameIndex(Math.min(frames.length - 1, frameIndex + 1))}
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
        <span className="reconstruction-note"><Info size={12} /> Paths join only adjacent, plausible source fixes; gaps stay open. The optional traffic layer never implies an incident role.</span>
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
  if (tone === 'official') return <span className="source-monogram source-monogram--rmi">LG</span>
  if (tone === 'report') return <span className="source-monogram source-monogram--rmi">LOC</span>
  if (tone === 'rmi') return <span className="source-monogram source-monogram--rmi">RMI</span>
  return <span className="source-monogram source-monogram--adsb"><Airplay size={17} /></span>
}

function DataModal({ open, onClose, onImportTracks, importedCount, firmsState, firmsDetectionCount }) {
  const [tab, setTab] = useState('connections')
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const closeOnEscape = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open, onClose])

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
                  <div className="connection-title"><strong>NASA FIRMS</strong><span className="status-pill status-pill--connected"><Check size={11} /> {firmsState.status === 'live' ? 'SERVER REFRESH' : 'AUDITED SNAPSHOT'}</span></div>
                  <p>{firmsDetectionCount} exact thermal-anomaly detections from Suomi-NPP, NOAA-20, NOAA-21 and MODIS are bundled. {firmsState.status === 'live' ? 'A server-side refresh has been merged into that historical record.' : 'The audited snapshot remains available without a viewer key.'}</p>
                  <span className="connection-meta">15 km incident filter · acquisition times preserved · no browser-stored API key</span>
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
                    <span className="connection-title"><strong>Mont Rigi weather</strong><span className="status-pill status-pill--key">AWAITING QC</span></span>
                    <p>Ten-minute measurements from RMI station 6494, 4.2 km from Drossart. RMI has not yet quality-validated any field in this near-real-time window.</p>
                    <span className="connection-meta">Official RMI station observations · Open-Meteo hourly model fallback</span>
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
                <article><span>01</span><div><strong>Thermal anomaly</strong><p>FIRMS footprints appear at their exact acquisition time. VIIRS areas are confidence-sensitive footprint-union estimates; MODIS is detections-only because its pixels are too coarse at this incident scale.</p></div></article>
                <article><span>02</span><div><strong>Reported area</strong><p>The line is a timestamped step series: ~60 ha at 16:00, ~100 ha at 20:00, ~850 ha at 07:00, then &gt;900 ha at 11:28. Between reports it means “last reported,” not measured growth.</p></div></article>
                <article><span>03</span><div><strong>EFFIS daily geometry</strong><p>The 14 and 15 August VIIRS-derived polygons are separate calendar-day products. Their locally calculated geometry area is not the official affected area; EFFIS provides no within-day acquisition time for five-minute animation.</p></div></article>
                <article><span>04</span><div><strong>Aircraft observations</strong><p>G10 and G17 are shown as individual Airplanes.live MLAT fixes. Gaps stay empty, and a marker never claims a helicopter remained airborne.</p></div></article>
                <article><span>05</span><div><strong>Nearby traffic census</strong><p>The optional traffic layer contains every other identifier seen within 5 km in either retained replay. Exact samples extend to 10 km for path context; none is assigned an incident role.</p></div></article>
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
              <div className="source-footnote"><CircleHelp size={15} /><p>Historical source responses remain timestamped and auditable. FIRMS uses a bundled reviewed snapshot and an optional server-side refresh; no key is sent to or stored by the viewer.</p></div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function App() {
  const [frames, setFrames] = useState(fireFrames)
  const framesLengthRef = useRef(fireFrames.length)
  const [frameIndex, setFrameIndex] = useState(fireFrames.length - 1)
  const [layers, setLayers] = useState(INITIAL_LAYER_STATE)
  const [baseMode, setBaseMode] = useState('terrain')
  const [playing, setPlaying] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [inspectorTab, setInspectorTab] = useState('situation')
  const [dataOpen, setDataOpen] = useState(false)
  const [mapActions, setMapActions] = useState(null)
  const [mobileLayersOpen, setMobileLayersOpen] = useState(false)
  const [importedTracks, setImportedTracks] = useState([])
  const [firmsData, setFirmsData] = useState(EMPTY_FIRMS_DATA)
  const [firmsState, setFirmsState] = useState({ status: 'checking', generatedAt: null })
  const [nearbyTraffic, setNearbyTraffic] = useState([])
  const [trafficLoadStatus, setTrafficLoadStatus] = useState('idle')
  const [trafficLoadError, setTrafficLoadError] = useState('')
  const [liveAircraftObservations, setLiveAircraftObservations] = useState([])
  const [syncState, setSyncState] = useState({ status: 'loading', generatedAt: null, weatherOk: false, aircraftOk: false })
  const frame = frames[Math.min(frameIndex, frames.length - 1)]
  const currentEffisArea = effisAreaForTimestamp(frame.timestampMs)
  const effisCarriedForward = currentEffisArea?.productDate === '2026-08-14'
    && frame.timestampMs >= Date.parse('2026-08-15T00:00:00+02:00')
  const layerOptions = useMemo(
    () => layerOptionsFor(currentEffisArea, effisCarriedForward, firmsData.sensors, frame),
    [currentEffisArea, effisCarriedForward, firmsData.sensors, frame],
  )
  const reportedAreaText = frame.reportedAreaText

  const displayFlights = useMemo(() => flights.map((flight) => {
    const live = liveAircraftObservations
      .filter((observation) => observation.icao24 === flight.icao24)
      .map((observation) => ({
        observedAt: observation.observedAt,
        timestampMs: Date.parse(observation.observedAt),
        position: [observation.latitude, observation.longitude],
        altitudeFt: observation.altitudeFt,
        updateType: observation.updateType,
      }))
    if (!live.length) return flight

    const observations = [...(flight.observations || []), ...live]
      .sort((left, right) => left.timestampMs - right.timestampMs)
      .filter((observation, index, all) => {
        const previous = all[index - 1]
        return !previous
          || observation.timestampMs !== previous.timestampMs
          || observation.position[0] !== previous.position[0]
          || observation.position[1] !== previous.position[1]
      })
    return { ...flight, observations }
  }), [liveAircraftObservations])

  useEffect(() => {
    let cancelled = false

    async function refreshLiveSituation() {
      try {
        const response = await fetch('/api/live-situation', { headers: { Accept: 'application/json' } })
        if (!response.ok) throw new Error(`Live endpoint returned ${response.status}`)
        const snapshot = await response.json()
        if (cancelled) return

        if (snapshot.weather?.ok && snapshot.weather.rows?.length) {
          const endMs = Date.parse(snapshot.generatedAt)
          const nextFrames = buildFireFrames({
            endMs,
            weatherRows: [...bundledWeatherRows, ...snapshot.weather.rows],
          })
          const previousLength = framesLengthRef.current
          setFrameIndex((currentIndex) => (
            currentIndex >= previousLength - 2
              ? nextFrames.length - 1
              : Math.min(currentIndex, nextFrames.length - 1)
          ))
          framesLengthRef.current = nextFrames.length
          setFrames(nextFrames)
        }

        if (snapshot.aircraft?.ok && snapshot.aircraft.observations?.length) {
          setLiveAircraftObservations((current) => {
            const merged = [...current, ...snapshot.aircraft.observations]
            const seen = new Set()
            return merged.filter((observation) => {
              const key = `${observation.providerId}|${observation.icao24}|${observation.observedAt}|${observation.latitude}|${observation.longitude}`
              if (seen.has(key)) return false
              seen.add(key)
              return true
            }).slice(-500)
          })
        }

        const weatherOk = Boolean(snapshot.weather?.ok)
        const aircraftOk = Boolean(snapshot.aircraft?.ok)
        setSyncState({
          status: weatherOk && aircraftOk ? 'live' : weatherOk || aircraftOk ? 'partial' : 'bundled',
          generatedAt: snapshot.generatedAt,
          weatherOk,
          aircraftOk,
        })
      } catch {
        if (!cancelled) setSyncState((current) => ({ ...current, status: 'bundled' }))
      }
    }

    refreshLiveSituation()
    const timer = window.setInterval(refreshLiveSituation, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let bundledSnapshot = null

    async function refreshFirms() {
      try {
        if (!bundledSnapshot) {
          const module = await import('./firmsDetectionsSnapshot.json')
          bundledSnapshot = module.default
          if (!cancelled) {
            setFirmsData(bundledSnapshot)
            setFirmsState({ status: 'bundled', configured: false, generatedAt: bundledSnapshot.generatedAt })
          }
        }
        const response = await fetch('/api/firms-situation', { headers: { Accept: 'application/json' } })
        if (!response.ok) throw new Error(`FIRMS endpoint returned ${response.status}`)
        const payload = await response.json()
        if (cancelled) return
        if (!payload.ok || !Array.isArray(payload.detections) || !Array.isArray(payload.sensors)) {
          setFirmsState({
            status: 'bundled',
            configured: Boolean(payload.configured),
            generatedAt: bundledSnapshot.generatedAt,
          })
          return
        }
        setFirmsData(mergeFirmsData(bundledSnapshot, payload))
        setFirmsState({ status: 'live', configured: true, generatedAt: payload.generatedAt })
      } catch {
        if (!cancelled && bundledSnapshot) {
          setFirmsData(bundledSnapshot)
          setFirmsState({ status: 'bundled', configured: false, generatedAt: bundledSnapshot.generatedAt })
        }
      }
    }

    refreshFirms()
    const timer = window.setInterval(refreshFirms, FIRMS_REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!playing) return undefined
    const delay = 1100 / playbackRate
    const timer = window.setInterval(() => {
      setFrameIndex((current) => {
        if (current >= frames.length - 1) {
          setPlaying(false)
          return current
        }
        return current + 1
      })
    }, delay)
    return () => window.clearInterval(timer)
  }, [playing, playbackRate, frames.length])

  useEffect(() => {
    if ((!layers.traffic && inspectorTab !== 'traffic') || trafficLoadStatus !== 'idle') return
    setTrafficLoadStatus('loading')
    import('./nearbyTrafficSnapshot.json')
      .then((module) => {
        setNearbyTraffic(normalizeNearbyTrafficSnapshot(module.default))
        setTrafficLoadStatus('loaded')
      })
      .catch((error) => {
        setTrafficLoadError(error.message)
        setTrafficLoadStatus('error')
      })
  }, [layers.traffic, inspectorTab])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (dataOpen || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return
      if (event.key === 'ArrowLeft') setFrameIndex((value) => Math.max(0, value - 1))
      if (event.key === 'ArrowRight') setFrameIndex((value) => Math.min(frames.length - 1, value + 1))
      if (event.key === ' ') {
        event.preventDefault()
        setPlaying((value) => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dataOpen, frames.length])

  const currentEvents = useMemo(
    () => events.filter((event) => event.frame <= frameIndex).slice(-5).reverse(),
    [frameIndex],
  )

  const nearbyWindReadings = useMemo(() => [
    ...(frame.drossartWind ? [{
      id: 'drossart-grid',
      name: 'Drossart grid',
      distanceLabel: 'incident locality',
      status: 'Open-Meteo model',
      color: '#72b7e6',
      ...frame.drossartWind,
    }] : []),
    ...(frame.montRigiWind ? [{
      id: 'mont-rigi',
      name: 'Mont Rigi',
      distanceLabel: '4.2 km',
      status: 'RMI · awaiting validation',
      color: '#8fd7c7',
      ...frame.montRigiWind,
    }] : []),
    ...(frame.dwdWinds || []).map((reading) => ({
      ...reading,
      distanceLabel: `${reading.distanceKm.toFixed(1)} km`,
      status: 'DWD · preliminary',
      color: '#b9a0e8',
    })),
  ], [frame])

  const activeFlights = useMemo(
    () => displayFlights.filter((flight) => observationState(flight, frame).key === 'recent'),
    [displayFlights, frame],
  )

  const activeNearbyTraffic = useMemo(
    () => nearbyTraffic
      .filter((flight) => observationState(flight, frame).key === 'recent')
      .sort((left, right) => (
        (left.classification === 'low-level' ? 0 : 1) - (right.classification === 'low-level' ? 0 : 1)
        || (observationState(right, frame).latest?.altitudeFt ?? Number.POSITIVE_INFINITY)
          - (observationState(left, frame).latest?.altitudeFt ?? Number.POSITIVE_INFINITY)
      )),
    [frame, nearbyTraffic],
  )

  const observedNearbyTrafficCount = useMemo(
    () => nearbyTraffic.filter((flight) => flight.observations[0]?.timestampMs <= frame.timestampMs).length,
    [frame, nearbyTraffic],
  )

  // Bundled and live FIRMS detections, placed on the five-minute timeline by their exact
  // acquisition time. A detection appears from its overpass onward; it is never
  // back-dated and never interpolated between overpasses.
  const firmsDetections = useMemo(() => firmsData.detections.map((detection) => {
    const sensor = FIRMS_SENSORS.find((entry) => entry.key === detection.sensorKey)
    return {
      ...detection,
      sensorName: sensor?.name ?? detection.sensorKey,
      sensorColor: sensor?.color ?? '#efaa3c',
      position: [detection.latitude, detection.longitude],
      frame: Math.max(0, Math.ceil((Date.parse(detection.acquiredAt) - TIMELINE_START_MS) / FIVE_MINUTES_MS)),
    }
  }), [firmsData.detections])

  const activeConfidenceLevels = useMemo(
    () => FIRMS_CONFIDENCE_LEVELS.filter((entry) => layers[entry.key]).map((entry) => entry.level),
    [layers],
  )

  const firmsDetectionsAtTime = useMemo(
    () => firmsDetections.filter((detection) => detection.frame <= frameIndex),
    [firmsDetections, frameIndex],
  )

  const visibleFirmsDetections = useMemo(() => firmsDetectionsAtTime.filter((detection) => (
    layers[FIRMS_LAYER_KEYS[detection.sensorKey]]
      && activeConfidenceLevels.includes(detection.confidence.label)
  )), [firmsDetectionsAtTime, layers, activeConfidenceLevels])

  // The estimate is recomputed here from the checked sensors and checked
  // confidence levels rather than read from a stored figure, so what is shown
  // always matches what is drawn. Sensors are estimated separately and never
  // summed: the same ground seen by two satellites is two observations.
  const firmsAreaEstimates = useMemo(() => FIRMS_SENSORS
    .filter((sensor) => AREA_CAPABLE_SENSORS.has(sensor.key) && layers[FIRMS_LAYER_KEYS[sensor.key]])
    .map((sensor) => {
      const forSensor = visibleFirmsDetections.filter((detection) => detection.sensorKey === sensor.key)
      return {
        sensorKey: sensor.key,
        name: sensor.name,
        color: sensor.color,
        detectionCount: forSensor.length,
        areaHa: estimateFootprintArea(forSensor, {
          origin: {
            latitude: firmsData.locationReference.latitude,
            longitude: firmsData.locationReference.longitude,
          },
        }).unionHa,
      }
    })
    .filter((estimate) => estimate.detectionCount > 0), [visibleFirmsDetections, layers, firmsData.locationReference])

  // A range across sensors, never an average or a total. Independent sensors
  // disagreeing is information, not noise to be smoothed away.
  const firmsAreaRange = useMemo(() => {
    if (!firmsAreaEstimates.length) return null
    const values = firmsAreaEstimates.map((estimate) => estimate.areaHa)
    return { min: Math.min(...values), max: Math.max(...values), sensorCount: values.length }
  }, [firmsAreaEstimates])

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
          <div className="updated-state"><span className={`live-pulse ${syncState.status === 'live' ? '' : 'is-bundled'}`} /><div><small>{syncState.status === 'live' ? 'WEATHER · LIVE ADS-B REFRESHED' : syncState.status === 'partial' ? 'PARTIAL LIVE REFRESH' : syncState.status === 'loading' ? 'CHECKING LIVE SOURCES' : 'BUNDLED SNAPSHOT'}</small><strong>{frames.at(-1).dayLabel} · {frames.at(-1).shortTime} CEST</strong></div></div>
          <button className="data-button" type="button" onClick={() => setDataOpen(true)}><Database size={15} /><span>Data & sources</span></button>
        </div>
      </header>

      <div className="workspace">
        <aside className={`left-sidebar ${mobileLayersOpen ? 'is-mobile-open' : ''}`}>
          <button className="mobile-sidebar-close" type="button" onClick={() => setMobileLayersOpen(false)}>
            <span>Close layers</span><X size={17} />
          </button>
          <div className="incident-card">
            <div className="incident-card-head">
              <span className="active-tag"><i /> INCIDENT RECORD</span>
              <button type="button" aria-label="Incident information"><Info size={15} /></button>
            </div>
            <h1>High Fens<br />wildfire</h1>
            <p>Drossart · Fagne des Deux-Séries</p>
            <div className="incident-metrics">
              <div><strong>{reportedAreaText}</strong><span>reported hectares</span><small>{frame.areaLabel}</small></div>
              <div><strong>{currentEffisArea ? Math.round(currentEffisArea.areaHa).toLocaleString('en-GB') : '—'}</strong><span>EFFIS geometry ha</span><small>{currentEffisArea ? `${currentEffisArea.productDate}${effisCarriedForward ? ' carried forward' : ''} · not fire size` : 'no product available at this time'}</small></div>
            </div>
          </div>

          <div className="sidebar-section layers-section">
            <div className="section-heading"><span>MAP LAYERS</span><button type="button" onClick={() => setLayers(INITIAL_LAYER_STATE)} aria-label="Reset map layers"><RotateCcw size={13} /></button></div>
            <div className="layer-list">
              {layerOptions.map((item) => (
                <LayerToggle
                  key={item.key}
                  item={item}
                  checked={layers[item.key]}
                  onChange={() => {
                    setLayers((value) => ({ ...value, [item.key]: !value[item.key] }))
                    setMobileLayersOpen(false)
                  }}
                />
              ))}
            </div>

            <div className="section-heading section-heading--sub"><span>FIRMS CONFIDENCE</span></div>
            <div className="layer-checkboxes">
              {FIRMS_CONFIDENCE_LEVELS.map((entry) => {
                const count = firmsDetectionsAtTime.filter((detection) => detection.confidence.label === entry.level).length
                return (
                  <label className="layer-checkbox" key={entry.key}>
                    <input
                      type="checkbox"
                      checked={Boolean(layers[entry.key])}
                      onChange={() => setLayers((value) => ({ ...value, [entry.key]: !value[entry.key] }))}
                    />
                    <span>{entry.label}</span>
                    <em>{count}</em>
                  </label>
                )
              })}
            </div>
            <p className="layer-note">
              {firmsAreaRange
                ? (firmsAreaRange.sensorCount > 1
                  ? `Detection-footprint estimate ${Math.round(firmsAreaRange.min).toLocaleString('en-GB')}–${Math.round(firmsAreaRange.max).toLocaleString('en-GB')} ha across ${firmsAreaRange.sensorCount} sensors, at the selected confidence levels. Not a burned area.`
                  : `Detection-footprint estimate ${Math.round(firmsAreaRange.max).toLocaleString('en-GB')} ha at the selected confidence levels. Not a burned area.`)
                : 'No FIRMS detections at the selected sensors, confidence levels and time.'}
            </p>
          </div>

          <div className="sidebar-section source-summary">
            <div className="section-heading"><span>SOURCE HEALTH</span><button type="button" onClick={() => setDataOpen(true)}>Manage</button></div>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="nasa" /><span><strong>FIRMS</strong><small>{`${firmsData.detections.length} exact detections · ${visibleFirmsDetections.length} shown · ${firmsState.status === 'live' ? 'server refreshed' : 'audited snapshot'}`}</small></span><em className={`health-dot ${firmsState.status === 'live' ? '' : 'health-dot--amber'}`} />
            </button>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="effis" /><span><strong>EFFIS daily geometry</strong><small>{currentEffisArea ? `${currentEffisArea.productDate}${effisCarriedForward ? ' carried forward' : ''} · not official fire size` : 'not yet available at selected time'}</small></span><em className="health-dot health-dot--amber" />
            </button>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="official" /><span><strong>Affected-area reports</strong><small>{frame.reportedAreaText} ha · {frame.areaLabel}</small></span><em className="health-dot health-dot--amber" />
            </button>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone={frame.weatherSourceKind === 'station-observation' ? 'rmi' : 'weather'} /><span><strong>{frame.weatherSourceKind === 'station-observation' ? 'Mont Rigi station' : 'Wind model fallback'}</strong><small>{frame.weatherSourceKind === 'station-observation' ? `10 min observation · ${frame.weatherAgeMinutes} min old · awaiting RMI validation` : 'Open-Meteo hourly grid value'}</small></span><em className={`health-dot ${frame.weatherSourceKind === 'station-observation' ? 'health-dot--amber' : ''}`} />
            </button>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="adsb" /><span><strong>Aircraft</strong><small>{displayFlights.length} sourced set{importedTracks.length ? ` · ${importedTracks.length} static import` : ''}</small></span><em className="health-dot" /></button>
            <button className="source-health-row" onClick={() => {
              setInspectorTab('traffic')
              setLayers((current) => ({ ...current, traffic: true }))
            }} type="button">
              <SourceMark tone="adsb" /><span><strong>Area traffic</strong><small>{nearbyTrafficMeta.aircraftCount} other identifiers · 2 replays</small></span><em className="health-dot" />
            </button>
          </div>

          <div className="emergency-note">
            <ShieldAlert size={17} />
            <p><strong>Not an emergency service</strong><span>For official instructions follow BE-Alert and call 112 only for an emergency.</span></p>
          </div>
        </aside>

        <main className="map-region">
          <MapView
            frameIndex={frameIndex}
            frame={frame}
            flights={displayFlights}
            effisArea={currentEffisArea}
            effisCarriedForward={effisCarriedForward}
            layers={layers}
            baseMode={baseMode}
            onMapReady={setMapActions}
            importedTracks={importedTracks}
            firmsDetections={visibleFirmsDetections}
            nearbyTraffic={nearbyTraffic}
          />

          <div className="map-topbar">
            <button className="mobile-layer-button" type="button" onClick={() => setMobileLayersOpen((value) => !value)}><Layers3 size={16} /> Layers</button>
            <div className="basemap-switcher" role="group" aria-label="Base map">
              <button className={baseMode === 'terrain' ? 'is-active' : ''} onClick={() => setBaseMode('terrain')} type="button"><Map size={14} /> Map</button>
              <button className={baseMode === 'satellite' ? 'is-active' : ''} onClick={() => setBaseMode('satellite')} type="button"><Satellite size={14} /> Satellite</button>
              <button className={baseMode === 'topo' ? 'is-active' : ''} onClick={() => setBaseMode('topo')} type="button"><Mountain size={14} /> Topo</button>
            </div>
            <div className="map-date-chip"><CalendarDays size={14} /><span>{frame.dayLabel}</span><strong>{frame.shortTime}</strong></div>
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
            frames={frames}
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
            <button className={inspectorTab === 'air' ? 'is-active' : ''} onClick={() => setInspectorTab('air')} type="button">Air ops <span>{displayFlights.length + importedTracks.length}</span></button>
            <button className={inspectorTab === 'traffic' ? 'is-active' : ''} onClick={() => {
              setInspectorTab('traffic')
              setLayers((current) => ({ ...current, traffic: true }))
            }} type="button">Traffic <span>{nearbyTrafficMeta.aircraftCount}</span></button>
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
                <article className="snapshot-card snapshot-card--effis"><span><Layers3 size={15} /> EFFIS DAILY GEOMETRY</span><strong>{currentEffisArea ? Math.round(currentEffisArea.areaHa).toLocaleString('en-GB') : '—'}<small>{currentEffisArea ? 'ha' : ''}</small></strong><p>{currentEffisArea ? `${currentEffisArea.productDate}${effisCarriedForward ? ' carried forward until replacement' : ''} · not official fire size` : 'no EFFIS product available at selected time'}</p></article>
                <article className="snapshot-card"><span><Satellite size={15} /> HOTSPOTS</span><strong>{visibleFirmsDetections.length}<small>px</small></strong><p>{firmsAreaRange ? `${firmsAreaRange.sensorCount > 1 ? `${Math.round(firmsAreaRange.min).toLocaleString('en-GB')}–${Math.round(firmsAreaRange.max).toLocaleString('en-GB')}` : Math.round(firmsAreaRange.max).toLocaleString('en-GB')} ha footprint estimate · not fire size` : 'no detections at this time'}</p></article>
                <article className="snapshot-card"><span><Helicopter size={15} /> AIR OPS</span><strong>{activeFlights.length}<small>recent</small></strong><p>{activeFlights.length ? 'fix within previous 5 min' : 'no recent observation'}</p></article>
                <article className="snapshot-card snapshot-card--traffic"><span><Radio size={15} /> OTHER TRAFFIC</span><strong>{trafficLoadStatus === 'loaded' ? activeNearbyTraffic.length : '—'}<small>{trafficLoadStatus === 'loaded' ? 'recent' : ''}</small></strong><p>{trafficLoadStatus === 'loaded' ? `${observedNearbyTrafficCount}/${nearbyTrafficMeta.aircraftCount} identifiers seen by this time` : 'optional replay layer not loaded'}</p></article>
                <article className="snapshot-card snapshot-card--wind"><span><Wind size={15} /> WIND FROM</span><strong>{windCardinal(frame.windDirection)}<small>{frame.windDirection.toFixed(0)}°</small></strong><p>{frame.windSpeed.toFixed(1)} km/h · gust {frame.gust.toFixed(0)} · {frame.weatherSourceKind === 'station-observation' ? 'station obs.' : 'model'}</p></article>
              </div>

              <div className="conditions-card">
                <div className="section-heading"><span>FIRE WEATHER</span><small>{frame.weatherSourceKind === 'station-observation' ? `Mont Rigi · 10 min · ${frame.weatherAgeMinutes} min old` : 'Drossart · hourly model fallback'}</small></div>
                <div className="wind-hero">
                  <span className="big-wind-arrow" title={`Wind travelling toward ${(frame.windDirection + 180) % 360}°`}>
                    <svg viewBox="0 0 24 24" style={{ '--wind-rotation': `${(frame.windDirection + 180) % 360}deg` }} aria-hidden="true">
                      <path d="M12 20V4M6.5 9.5 12 4l5.5 5.5" />
                    </svg>
                  </span>
                  <div><strong>{windCardinal(frame.windDirection)}</strong><span>from {frame.windDirection}° · wind blowing toward {(frame.windDirection + 180) % 360}°</span></div>
                  <p><strong>{frame.windSpeed.toFixed(1)}</strong><span>km/h</span><small>gusts {frame.gust.toFixed(1)}</small></p>
                </div>
                <div className="condition-row">
                  <span><ThermometerSun size={15} /> Temperature<strong>{frame.temperature.toFixed(1)}°C</strong></span>
                  <span><Droplets size={15} /> Humidity<strong>{frame.humidity.toFixed(1)}%</strong></span>
                </div>
                <p className={`weather-provenance ${frame.weatherSourceKind === 'station-observation' ? 'is-unvalidated' : ''}`}>
                  {frame.weatherSourceKind === 'station-observation'
                    ? `RMI station 6494, ${frame.weatherStationDistanceKm} km from Drossart. Near-real-time measurement awaiting RMI quality validation; conditions at the fire may differ.`
                    : 'Open-Meteo model-grid fallback, not a station measurement.'}
                </p>
                <div className="wind-source-comparison">
                  <div className="wind-source-comparison__head"><strong>Nearby wind sources</strong><small>independent · never blended</small></div>
                  {nearbyWindReadings.map((reading) => (
                    <div className="wind-source-reading" key={reading.id}>
                      <span className="wind-source-reading__arrow" style={{ '--source-color': reading.color, '--wind-rotation': `${(reading.windDirection + 180) % 360}deg` }}>
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V4M6.5 9.5 12 4l5.5 5.5" /></svg>
                      </span>
                      <span><strong>{reading.name}</strong><small>{reading.distanceLabel} · {reading.status}</small></span>
                      <span><strong>{windCardinal(reading.windDirection)} <small>from</small></strong><small>{reading.windSpeed.toFixed(1)} km/h · {reading.ageMinutes} min old</small></span>
                    </div>
                  ))}
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
          ) : inspectorTab === 'air' ? (
            <div className="inspector-scroll air-ops-panel">
              <div className="air-ops-summary">
                <span className="kicker">TRACK COVERAGE</span>
                <h2>Aerial operations</h2>
                <p>G10 and G17 have incident-area MLAT observations; G12 is confirmed only by a timestamped 14 August photo. The 15 August heatmap replay is single-provider evidence and does not identify water pickups or drops.</p>
                <button type="button" onClick={() => setDataOpen(true)}><FileUp size={14} /> Import tracks</button>
              </div>

              <div className="flight-list">
                {[...displayFlights, ...importedTracks].map((flight) => {
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

              <div className="coverage-note"><Radio size={15} /><p><strong>Dots are observations; dashed lines are not flight paths.</strong><span>Airplanes.live supplied 30-second MLAT replay samples for G10 and G17 on 15 August. Straight connectors appear only across gaps ≤2 minutes and plausible speed. G12 remains photo-only near this incident.</span></p></div>
              <div className="coverage-note"><Info size={15} /><p><strong>Wide-area checks separate this incident from nearby activity.</strong><span>{incidentAircraftMeta.negativeFindings[0]} {incidentAircraftMeta.negativeFindings[1]} The known Aachen/Walheim MLAT artifact is excluded.</span></p></div>
            </div>
          ) : (
            <div className="inspector-scroll traffic-panel">
              <div className="traffic-summary">
                <span className="kicker">RECEIVER CENSUS · 5 KM</span>
                <h2>Nearby traffic</h2>
                <p>Every other identifier observed within 5 km of Drossart in either retained replay. Paths use exact samples out to 10 km for context. None is classified as an incident aircraft.</p>
                <button type="button" onClick={() => setLayers((current) => ({ ...current, traffic: !current.traffic }))}>
                  {layers.traffic ? <EyeOff size={14} /> : <Eye size={14} />}
                  {layers.traffic ? 'Hide traffic layer' : 'Show traffic layer'}
                </button>
                <div className="traffic-metrics">
                  <span><strong>{nearbyTrafficMeta.aircraftCount}</strong><small>IDENTIFIERS</small></span>
                  <span><strong>{nearbyTrafficMeta.lowLevelAircraftCount}</strong><small>LOW-LEVEL</small></span>
                  <span><strong>{nearbyTrafficMeta.observationCount}</strong><small>SOURCE FIXES</small></span>
                </div>
              </div>

              {trafficLoadStatus === 'loading' && <div className="traffic-load-state"><Activity size={16} /><span>Loading the checked-in replay snapshot…</span></div>}
              {trafficLoadStatus === 'error' && <div className="traffic-load-state is-error"><BadgeAlert size={16} /><span>{trafficLoadError || 'The replay snapshot could not be loaded.'}</span></div>}

              {trafficLoadStatus === 'loaded' && <>
              <section className="recent-traffic">
                <div className="section-heading"><span>AT SELECTED TIME</span><small>{activeNearbyTraffic.length} seen in prior 5 min</small></div>
                {activeNearbyTraffic.length ? (
                  <div className="recent-traffic-list">
                    {activeNearbyTraffic.slice(0, 16).map((flight) => {
                      const latest = observationState(flight, frame).latest
                      return (
                        <article key={flight.id}>
                          <i style={{ '--traffic-color': flight.color }} />
                          <span><strong>{flight.callSign || flight.registration || flight.icao24}</strong><small>{flight.classification === 'low-level' ? 'had a ≤5,000 ft sample in the scan' : 'high-altitude overflight'} · no incident role</small></span>
                          <span><strong>{latest?.altitudeFt ?? '—'} ft</strong><small>{latest ? localClock(latest.observedAt) : '—'} CEST</small></span>
                        </article>
                      )
                    })}
                    {activeNearbyTraffic.length > 16 && <p>+{activeNearbyTraffic.length - 16} more recently observed identifiers on the map.</p>}
                  </div>
                ) : (
                  <p className="traffic-empty">No retained receiver observation falls within the previous five minutes.</p>
                )}
              </section>

              <section className="low-level-ledger">
                <div className="section-heading"><span>LOW-LEVEL REVIEW SET</span><small>≤5,000 ft filter</small></div>
                <div className="traffic-ledger-list">
                  {nearbyTraffic.filter((flight) => flight.classification === 'low-level').map((flight) => (
                    <article key={flight.id}>
                      <div><strong>{flight.callSign || flight.registration || flight.icao24}</strong><small>{flight.registration || flight.icao24}</small></div>
                      <p>{flight.label}<small>{localClock(flight.firstObservedAt)}–{localClock(flight.lastObservedAt)} CEST · {flight.source}</small></p>
                      <span><strong>{flight.nearestDrossartKm.toFixed(1)} km</strong><small>closest</small></span>
                    </article>
                  ))}
                </div>
              </section>

              <div className="coverage-note"><Info size={15} /><p><strong>Low altitude is a review filter, not a mission label.</strong><span>The two Cessna 208s are known parachuting aircraft; the other five have no sourced firefighting role. High-altitude traffic remains available on the map but is visually subdued.</span></p></div>
              </>}
            </div>
          )}
        </aside>
      </div>

      <DataModal
        open={dataOpen}
        onClose={() => setDataOpen(false)}
        onImportTracks={importTracks}
        importedCount={importedTracks.length}
        firmsState={firmsState}
        firmsDetectionCount={firmsData.detections.length}
      />
    </div>
  )
}

export default App
