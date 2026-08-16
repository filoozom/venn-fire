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
  Siren,
  Sparkles,
  ThermometerSun,
  Wind,
  X,
} from 'lucide-react'
import MapView from './MapView'
import {
  AIRCRAFT_EDGE_GRID_CELL_M,
  AIRCRAFT_EDGE_TIME_BUCKET_MS,
  deriveAircraftSupportedEdge,
} from './aircraftFireEstimate'
import {
  effisAreaForTimestamp,
  effisProductIsCarriedForward,
  FIVE_MINUTES_MS,
  mergeIncidentFlights,
  runtimeDataFromResponse,
} from './data'
import {
  footprintOutlineRings,
  FIRMS_SENSORS,
  corroborateDetections,
  detectionFootprint,
  estimateFootprintArea,
  firmsDetectionVisibleAt,
} from './firmsDetections'
import {
  MODIS_EXTENT_GRID_CELL_M,
  MODIS_EXTENT_RULE,
  MODIS_EXTENT_TIME_BUCKET_MS,
  deriveModisSupportedExtent,
} from './modisFireEstimate'

// Each raw sensor is its own layer and each confidence level its own filter. The
// Best estimate is separate: its single solid outline follows a fixed,
// documented VIIRS + newest-pass MODIS selection rule.
const FIRMS_LAYER_KEYS = Object.fromEntries(FIRMS_SENSORS.map((sensor) => [sensor.key, `firms:${sensor.key}`]))
// Independent-satellite agreement, kept separate from the published confidence
// field. NASA's confidence value is never rewritten: a detection we cannot
// corroborate is still exactly what NASA reported it to be.
const FIRE_OUTLINE_KEY = 'fireOutline'

const FIRMS_CONFIDENCE_LEVELS = [
  { key: 'firmsConfidence:high', level: 'high', label: 'High confidence' },
  { key: 'firmsConfidence:nominal', level: 'nominal', label: 'Nominal confidence' },
  { key: 'firmsConfidence:low', level: 'low', label: 'Low confidence' },
]

const FIRMS_LAYER_DEFAULTS = {
  // Each sensor declares its own default; coarse ones start hidden.
  ...Object.fromEntries(FIRMS_SENSORS.map((sensor) => [FIRMS_LAYER_KEYS[sensor.key], sensor.defaultVisible !== false])),
  'firmsConfidence:high': true,
  'firmsConfidence:nominal': true,
  'firmsConfidence:low': false,
}

// The best-estimate outline: two spacecraft agree on the cell and at least one
// reported high confidence there. Drawn as a single dissolved boundary rather
// than a mosaic of pixel rectangles.
const BEST_ESTIMATE_RULE = '2+ satellites agree and the cell has a high-confidence detection'

function dwdWindLayerKey(stationId) {
  return `dwdWind:${stationId}`
}

function initialLayerState(runtime) {
  return {
    ...runtime.initialLayers,
    officialPerimeter: Boolean(runtime.officialPerimeter?.current?.features?.length),
    ...FIRMS_LAYER_DEFAULTS,
    ...Object.fromEntries(runtime.dwdWindStations.map((station) => [dwdWindLayerKey(station.id), true])),
    [FIRE_OUTLINE_KEY]: true,
  }
}

function layerOptionsFor(effisArea, isCarriedForward, firmsSummaries = [], frame = null, dwdWindStations = [], officialPerimeter = null) {
  return [
  ...(officialPerimeter?.features?.length ? [{
    key: 'officialPerimeter',
    label: 'Field-confirmed perimeter',
    detail: `${officialPerimeter.features.length} agency GeoJSON feature${officialPerimeter.features.length === 1 ? '' : 's'}`,
    icon: LocateFixed,
    color: '#ff4f45',
  }] : []),
  { key: 'perimeter', label: 'EFFIS daily geometry', detail: effisArea ? `${effisArea.productDate}${isCarriedForward ? ' carried forward' : ''} · ${Math.round(effisArea.areaHa).toLocaleString('en-GB')} ha polygon` : 'No product available at selected time', icon: Layers3, color: '#e96838' },
  ...FIRMS_SENSORS.map((sensor) => {
    const summary = firmsSummaries.find((entry) => entry.sensorKey === sensor.key)
    const pixel = summary?.meanPixelHa
    return {
      key: FIRMS_LAYER_KEYS[sensor.key],
      label: sensor.name,
      detail: summary
        ? sensor.providesArea
          ? `${summary.detectionCount} detections · ${pixel ? `${Math.round(pixel)} ha mean pixel` : `${sensor.nominalResolutionM} m nominal`}`
          : `${summary.detectionCount} detections · ${sensor.pixelSizeLabel ?? `${sensor.nominalResolutionM} m nominal pixel`} · detections only, no area${sensor.instrument === 'GEO' ? ' · shown for 15 min around each scan' : ''}`
        : 'No detections in the database',
      icon: Satellite,
      color: sensor.color,
    }
  }),
  { key: 'aircraft', label: 'Aircraft observations', detail: 'Exact MLAT dots + gap-limited connectors', icon: Helicopter, color: '#3a7fcc' },
  { key: 'wind', label: 'Drossart model wind', detail: frame?.drossartWind ? `Open-Meteo hourly grid · ${frame.drossartWind.ageMinutes} min old` : 'No model value at selected time', icon: Wind, color: '#478fc4' },
  { key: 'rmiWind', label: 'Mont Rigi station wind', detail: frame?.montRigiWind ? `RMI 10 min observation · ${frame.montRigiWind.ageMinutes} min old · awaiting validation` : 'No station observation within 20 min of selected time', icon: Wind, color: '#4f9e90' },
  ...dwdWindStations.map((station) => {
    const reading = frame?.dwdWinds?.find((item) => item.id === station.id)
    return {
      key: dwdWindLayerKey(station.id),
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
  if (type === 'evacuation') return Siren
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

function Timeline({ frames, timelineEvents, frameIndex, setFrameIndex, playing, setPlaying, playbackRate, setPlaybackRate }) {
  const frame = frames[frameIndex]
  const progress = (frameIndex / (frames.length - 1)) * 100
  const visibleEvents = timelineEvents.filter((event) => event.frame <= frameIndex)
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
            {timelineEvents.filter((event) => event.frame < frames.length).map((event, index) => (
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
        <span className="reconstruction-note"><Info size={12} /> Paths join only adjacent, plausible source fixes; gaps stay open. Unrelated aircraft traffic is excluded.</span>
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

function DataModal({
  open,
  onClose,
  onImportTracks,
  importedCount,
  firmsState,
  firmsDetectionCount,
  sourceLinks,
  activeSources = [],
  coverageGaps = [],
  sourceRuns = [],
  sentinel2 = { scenes: [] },
}) {
  const [tab, setTab] = useState('connections')
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')
  const inputRef = useRef(null)
  const latestQuicklook = (sentinel2.scenes ?? []).filter((scene) => scene.quicklook?.stored).at(-1)
  const sourceRunByKey = new globalThis.Map(sourceRuns.map((run) => [run.sourceKey, run]))

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
        const groups = new globalThis.Map()
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
                  <div className="connection-title"><strong>NASA FIRMS</strong><span className="status-pill status-pill--connected"><Check size={11} /> DATABASE REFRESH</span></div>
                  <p>{firmsDetectionCount} exact thermal-anomaly detections from Suomi-NPP, NOAA-20, NOAA-21, MODIS and Meteosat are retained in Postgres. The Vercel refresh function merges polar overpasses and geostationary scans into that history.</p>
                  <span className="connection-meta">Checked every 5 min · provider lease 15 min · no browser-stored API key</span>
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

                <div className="connection-card connection-card--sentinel">
                  {latestQuicklook ? (
                    <img
                      className="sentinel-preview"
                      src={latestQuicklook.quicklook.databaseUrl}
                      alt={`Sentinel-2 quicklook acquired ${latestQuicklook.acquiredAt}`}
                    />
                  ) : <span className="connection-icon"><Satellite size={20} /></span>}
                  <span className="connection-copy">
                    <span className="connection-title"><strong>Sentinel-2 pixels</strong><span className="status-pill">{sentinel2.storedQuicklookCount ?? 0} STORED</span></span>
                    <p>{latestQuicklook ? `Latest retained quicklook: ${latestQuicklook.name}.` : 'The catalogue is synchronized; no public quicklook has been stored yet.'} Full multispectral processing remains a separate credentialed product.</p>
                    <span className="connection-meta">Public JPEG quicklooks · Postgres artifact bytes · hourly catalogue lease</span>
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
                <article><span>01</span><div><strong>Thermal anomaly</strong><p>FIRMS detections appear at their exact acquisition time. Raw sensor layers stay separate. The Best estimate merges its corroborated VIIRS core with only nearby high-confidence pixels from the newest MODIS pass; Meteosat remains detections-only.</p></div></article>
                <article><span>02</span><div><strong>Reported area</strong><p>The line is a timestamped step series. A figure becomes visible when published; when its stated effective time differs, both times are retained and shown. Between reports it means “last reported,” not measured growth.</p></div></article>
                <article><span>03</span><div><strong>EFFIS daily geometry</strong><p>The 14 and 15 August VIIRS-derived polygons are separate calendar-day products. Their locally calculated geometry area is not the official affected area; EFFIS provides no within-day acquisition time for five-minute animation.</p></div></article>
                <article><span>04</span><div><strong>Aircraft observations</strong><p>Identified incident aircraft are shown from exact receiver fixes returned by the independently health-checked aircraft providers. Gaps stay empty, and a marker never claims a helicopter remained airborne.</p></div></article>
                <article><span>05</span><div><strong>Situation reports</strong><p>The Governor of Liège page is polled every five minutes for official estimates and safety events. BRF figures remain distinctly labelled local reporting; every step links to its source.</p></div></article>
              </div>
              <div className="safety-note"><ShieldAlert size={17} /><span>This viewer is informational and must not be used for evacuation or preservation-of-life decisions. Follow BE-Alert and emergency services.</span></div>
            </div>
          )}

          {tab === 'sources' && (
            <div className="source-directory">
              <div className="directory-section-title">
                <strong>Continuous database synchronizers</strong>
                <small>{activeSources.filter((source) => source.access?.configured !== false).length}/{activeSources.length} connected or push-ready</small>
              </div>
              {activeSources.map((source) => {
                const run = sourceRunByKey.get(source.key)
                const state = source.access?.configured === false
                  ? 'AWAITING ACCESS'
                  : run?.status === 'failed' ? 'FAILED'
                    : run?.status === 'running' ? 'SYNCING'
                      : run?.metadata?.failedProviders?.length ? 'PARTIAL'
                        : `${source.intervalMinutes} MIN`
                const content = (
                  <>
                    <SourceMark tone={source.key === 'firms' ? 'nasa' : source.key === 'effis' || source.key === 'ems' || source.key === 'sentinel2' ? 'effis' : source.key.includes('meteo') || source.key === 'dwd' ? 'weather' : source.key === 'reports' || source.key === 'vedia' ? 'report' : source.key === 'local-authority-updates' || source.access?.kind === 'controlled' ? 'official' : 'adsb'} />
                    <span><strong>{source.label}</strong><small>{source.coverage}</small></span>
                    <em>{state}</em>
                    {source.providerUrl ? <ExternalLink size={15} /> : <CircleHelp size={15} />}
                  </>
                )
                return source.providerUrl ? (
                  <a key={source.key} href={source.providerUrl} target="_blank" rel="noreferrer" className="directory-row">{content}</a>
                ) : <div key={source.key} className="directory-row directory-row--inactive">{content}</div>
              })}
              {coverageGaps.length ? (
                <>
                  <div className="directory-section-title directory-section-title--references">
                    <strong>Known limits that are not synchronized</strong>
                    <small>Access, privacy or source-history constraints</small>
                  </div>
                  {coverageGaps.map((gap) => (
                    <div key={gap.key} className="directory-row directory-row--gap">
                      <SourceMark tone="official" />
                      <span><strong>{gap.key.replaceAll('-', ' ')}</strong><small>{gap.detail}</small></span>
                      <em>{gap.status.replaceAll('-', ' ')}</em>
                      <CircleHelp size={15} />
                    </div>
                  ))}
                </>
              ) : null}
              <div className="directory-section-title directory-section-title--references">
                <strong>Historical and methodological references</strong>
                <small>Linked evidence retained with the incident record</small>
              </div>
              {sourceLinks.map((source) => (
                <a key={source.name} href={source.url} target="_blank" rel="noreferrer" className="directory-row">
                  <SourceMark tone={source.tone} />
                  <span><strong>{source.name}</strong><small>{source.detail}</small></span>
                  <em>{source.cadence}</em>
                  <ExternalLink size={15} />
                </a>
              ))}
              <div className="source-footnote"><CircleHelp size={15} /><p>Current datasets, historical versions and migrated source artifacts are retained in Postgres. The browser reads the database only; provider credentials never reach the viewer.</p></div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function FireViewer({ runtime, databaseError }) {
  const frames = runtime.frames
  const displayEvents = runtime.events
  const framesLengthRef = useRef(frames.length)
  const [frameIndex, setFrameIndex] = useState(frames.length - 1)
  const [layers, setLayers] = useState(() => initialLayerState(runtime))
  const [baseMode, setBaseMode] = useState('terrain')
  const [playing, setPlaying] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [inspectorTab, setInspectorTab] = useState('situation')
  const [dataOpen, setDataOpen] = useState(false)
  const [mapActions, setMapActions] = useState(null)
  const [mobileLayersOpen, setMobileLayersOpen] = useState(false)
  const [importedTracks, setImportedTracks] = useState([])
  const firmsData = runtime.firms
  const firmsState = {
    status: databaseError ? 'stale' : 'live',
    configured: true,
    generatedAt: firmsData.generatedAt,
  }
  const liveAircraftObservations = runtime.aircraft.observations ?? []
  const sourceRuns = runtime.database?.sources ?? []
  const hasFailedSource = sourceRuns.some((source) => source.status === 'failed')
  const hasPartialSource = sourceRuns.some((source) => (
    source.metadata?.failedProviders?.length || source.metadata?.degradedProviders?.length
  ))
  const syncState = {
    status: databaseError ? 'stale' : hasFailedSource || hasPartialSource ? 'partial' : 'live',
    generatedAt: runtime.generatedAt,
    weatherOk: true,
    aircraftOk: sourceRuns.find((source) => source.sourceKey === 'aircraft')?.status === 'ok',
    reportsOk: Boolean(runtime.reports.ok),
    reportsComplete: Boolean(runtime.reports.complete),
  }
  const frame = frames[Math.min(frameIndex, frames.length - 1)]
  const currentEffisArea = effisAreaForTimestamp(runtime.effisProducts, frame.timestampMs)
  // "Carried forward" means the product predates the day being viewed, not that
  // it happens to be the 14 August one. On 14 August that product is current.
  const effisCarriedForward = effisProductIsCarriedForward(currentEffisArea, frame.timestampMs)
    && frame.timestampMs >= Date.parse('2026-08-15T00:00:00+02:00')
  const layerOptions = useMemo(
    () => layerOptionsFor(currentEffisArea, effisCarriedForward, firmsData.sensors, frame, runtime.dwdWindStations, runtime.officialPerimeter.current),
    [currentEffisArea, effisCarriedForward, firmsData.sensors, frame, runtime.dwdWindStations, runtime.officialPerimeter.current],
  )
  const reportedAreaText = frame.reportedAreaText

  const displayFlights = useMemo(
    () => mergeIncidentFlights(runtime.flights, liveAircraftObservations),
    [liveAircraftObservations, runtime.flights],
  )
  const receiverObservedFlights = displayFlights.filter((flight) => flight.observations?.length)
  const receiverObservedCallSigns = receiverObservedFlights.map((flight) => flight.callSign).join(', ')

  useEffect(() => {
    const previousLength = framesLengthRef.current
    setFrameIndex((currentIndex) => (
      currentIndex >= previousLength - 2
        ? frames.length - 1
        : Math.min(currentIndex, frames.length - 1)
    ))
    framesLengthRef.current = frames.length
    setLayers((current) => ({ ...initialLayerState(runtime), ...current }))
  }, [frames.length, runtime])

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
    // Every event up to the selected time, newest first. Capping this at five hid
    // earlier entries entirely, including the evacuation orders, and with them
    // their source links. The list scrolls instead.
    // Sorted, not reversed: the source array is not in chronological order, so
    // reversing it produced a list that only looked ordered.
    () => displayEvents
      .filter((event) => event.frame <= frameIndex)
      .slice()
      .sort((left, right) => right.frame - left.frame),
    [displayEvents, frameIndex],
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

  // Database-retained FIRMS detections, placed on the five-minute timeline by
  // exact acquisition time. Polar detections remain as historical evidence;
  // Meteosat is an instantaneous heat observation and is shown for 15 minutes
  // rather than accumulated into a false burned-area layer.
  const firmsDetections = useMemo(() => corroborateDetections(firmsData.detections).map((detection) => {
    const sensor = FIRMS_SENSORS.find((entry) => entry.key === detection.sensorKey)
    return {
      ...detection,
      sensorName: sensor?.name ?? detection.sensorKey,
      sensorColor: sensor?.color ?? '#efaa3c',
      providesArea: sensor?.providesArea === true,
      displayMode: detection.displayMode ?? sensor?.displayMode ?? 'footprint',
      pixelSizeLabel: sensor?.pixelSizeLabel ?? detection.pixelSizeLabel ?? `${detection.scanKm} × ${detection.trackKm} km pixel`,
      areaExclusionReason: sensor?.areaExclusionReason ?? detection.areaExclusionReason ?? null,
      footprint: detection.footprint ?? detectionFootprint(detection),
      position: [detection.latitude, detection.longitude],
      timestampMs: Date.parse(detection.acquiredAt),
      frame: Math.max(0, Math.ceil((Date.parse(detection.acquiredAt) - runtime.timelineStartMs) / FIVE_MINUTES_MS)),
    }
  }), [firmsData.detections, runtime.timelineStartMs])

  const activeConfidenceLevels = useMemo(
    () => FIRMS_CONFIDENCE_LEVELS.filter((entry) => layers[entry.key]).map((entry) => entry.level),
    [layers],
  )

  const firmsDetectionsAtTime = useMemo(
    () => firmsDetections.filter((detection) => firmsDetectionVisibleAt(detection, frame.timestampMs)),
    [firmsDetections, frame.timestampMs],
  )

  // The independently corroborated VIIRS core remains the anchor for both the
  // MODIS and aircraft selection rules.
  const bestEstimateCoreDetections = useMemo(
    () => firmsDetectionsAtTime.filter((detection) => detection.isFireCore),
    [firmsDetectionsAtTime],
  )

  const viirsCoreOutlineRings = useMemo(
    () => footprintOutlineRings(bestEstimateCoreDetections, {
      gridCellM: 50,
      origin: {
        latitude: firmsData.locationReference.latitude,
        longitude: firmsData.locationReference.longitude,
      },
    }),
    [bestEstimateCoreDetections, firmsData.locationReference],
  )

  const aircraftSupportedEdge = useMemo(() => deriveAircraftSupportedEdge({
    flights: displayFlights,
    detections: bestEstimateCoreDetections,
    outlineRings: viirsCoreOutlineRings,
    frameTimestampMs: frame.timestampMs,
    origin: firmsData.locationReference,
    gridCellM: AIRCRAFT_EDGE_GRID_CELL_M,
    timeBucketMs: AIRCRAFT_EDGE_TIME_BUCKET_MS,
  }), [displayFlights, bestEstimateCoreDetections, viirsCoreOutlineRings, frame.timestampMs, firmsData.locationReference])

  const modisSupportedExtent = useMemo(() => deriveModisSupportedExtent({
    detections: firmsDetectionsAtTime,
    coreDetections: bestEstimateCoreDetections,
    aircraftEdgeCandidates: aircraftSupportedEdge.candidates,
    frameTimestampMs: frame.timestampMs,
    origin: firmsData.locationReference,
    gridCellM: MODIS_EXTENT_GRID_CELL_M,
    timeBucketMs: MODIS_EXTENT_TIME_BUCKET_MS,
  }), [firmsDetectionsAtTime, bestEstimateCoreDetections, aircraftSupportedEdge.candidates, frame.timestampMs, firmsData.locationReference])

  // There is one satellite estimate, not a VIIRS outline plus a competing MODIS
  // outline. Qualifying pixels from the newest MODIS pass extend the same raster
  // union and therefore the same solid boundary and hectare figure.
  const bestEstimateDetections = useMemo(
    () => [...bestEstimateCoreDetections, ...modisSupportedExtent.detections],
    [bestEstimateCoreDetections, modisSupportedExtent.detections],
  )

  const fireOutlineRings = useMemo(
    () => footprintOutlineRings(bestEstimateDetections, {
      gridCellM: 50,
      origin: {
        latitude: firmsData.locationReference.latitude,
        longitude: firmsData.locationReference.longitude,
      },
    }),
    [bestEstimateDetections, firmsData.locationReference],
  )

  const visibleFirmsDetections = useMemo(() => firmsDetectionsAtTime.filter((detection) => (
    layers[FIRMS_LAYER_KEYS[detection.sensorKey]]
      && activeConfidenceLevels.includes(detection.confidence.label)
  )), [firmsDetectionsAtTime, layers, activeConfidenceLevels])

  // The estimate is the area of the exact 50 m raster union used by the solid
  // boundary, so the number and the map geometry cannot disagree.
  const bestEstimateAreaHa = useMemo(() => estimateFootprintArea(bestEstimateDetections, {
    origin: {
      latitude: firmsData.locationReference.latitude,
      longitude: firmsData.locationReference.longitude,
    },
  }).unionHa, [bestEstimateDetections, firmsData.locationReference])

  const firmsAreaEstimates = useMemo(() => FIRMS_SENSORS
    .filter((sensor) => sensor.providesArea && layers[FIRMS_LAYER_KEYS[sensor.key]])
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
          <div className="incident-location"><MapPin size={14} /><span>HIGH FENS</span><i>/</i><b>BAELEN · JALHAY</b></div>
          <span className="reference-badge"><Sparkles size={11} /> OBSERVATION VIEW</span>
        </div>

        <div className="header-actions">
          <div className="updated-state"><span className={`live-pulse ${syncState.status === 'live' ? '' : 'is-bundled'}`} /><div><small>{syncState.status === 'live' ? 'DATABASE SOURCES REFRESHED' : syncState.status === 'partial' ? 'PARTIAL SOURCE REFRESH' : 'DATABASE VIEW STALE'}</small><strong>{frames.at(-1).dayLabel} · {frames.at(-1).shortTime} CEST</strong></div></div>
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
              {/* The best estimate sits beside the reported figure. EFFIS keeps its
                  own card below: at roughly five times the reported area it is an
                  envelope, and giving it headline position overstated the burn. */}
              <div><strong>{bestEstimateDetections.length ? Math.round(bestEstimateAreaHa).toLocaleString('en-GB') : '—'}</strong><span>best-estimate ha</span><small>{bestEstimateDetections.length ? `${bestEstimateCoreDetections.length} VIIRS core${modisSupportedExtent.detections.length ? ` + ${modisSupportedExtent.detections.length} ${modisSupportedExtent.satellites.join('/')} MODIS` : ''} · derived` : 'no qualifying detections yet'}</small></div>
            </div>
          </div>

          <div className="sidebar-section layers-section">
            <div className="section-heading"><span>FIRE OUTLINE</span></div>
            <div className="layer-checkboxes">
              <label className="layer-checkbox" title={`${BEST_ESTIMATE_RULE}; ${MODIS_EXTENT_RULE}`}>
                <input
                  type="checkbox"
                  checked={Boolean(layers[FIRE_OUTLINE_KEY])}
                  onChange={() => setLayers((value) => ({ ...value, [FIRE_OUTLINE_KEY]: !value[FIRE_OUTLINE_KEY] }))}
                />
                <span>Best estimate outline</span>
                <em>{bestEstimateDetections.length ? `${Math.round(bestEstimateAreaHa).toLocaleString('en-GB')} sat. ha` : '—'}</em>
              </label>
            </div>
            <div className="outline-method-key" aria-label="Best estimate outline methods">
              <span><i className="is-satellite" /> Satellite estimate</span>
              {aircraftSupportedEdge.candidates.length ? <span><i className="is-aircraft" /> Aircraft-supported edge</span> : null}
            </div>
            <p className="layer-note">
              {bestEstimateDetections.length
                ? `Solid red: one ${Math.round(bestEstimateAreaHa).toLocaleString('en-GB')} ha satellite estimate from ${bestEstimateCoreDetections.length} corroborated VIIRS detections${modisSupportedExtent.detections.length ? ` plus ${modisSupportedExtent.detections.length} high-confidence ${modisSupportedExtent.satellites.join('/')} MODIS pixels from the newest pass` : ''}. 50 m grid; not a confirmed burned-area perimeter.${aircraftSupportedEdge.candidates.length ? ` Dashed amber: ${aircraftSupportedEdge.callSigns.join(', ')} context only; receiver data cannot confirm a drop.` : ''}`
                : 'No detections meet the best-estimate rule at this time.'}
            </p>
          </div>

          <div className="sidebar-section layers-section">
            <div className="section-heading"><span>MAP LAYERS</span><button type="button" onClick={() => setLayers(initialLayerState(runtime))} aria-label="Reset map layers"><RotateCcw size={13} /></button></div>
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


          </div>

          <div className="sidebar-section source-summary">
            <div className="section-heading"><span>SOURCE HEALTH</span><button type="button" onClick={() => setDataOpen(true)}>Manage</button></div>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="nasa" /><span><strong>FIRMS</strong><small>{`${firmsData.detections.length} exact detections · ${visibleFirmsDetections.length} shown · ${firmsState.status === 'live' ? 'database refreshed' : 'database view stale'}`}</small></span><em className={`health-dot ${firmsState.status === 'live' ? '' : 'health-dot--amber'}`} />
            </button>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="effis" /><span><strong>EFFIS daily geometry</strong><small>{currentEffisArea ? `${currentEffisArea.productDate}${effisCarriedForward ? ' carried forward' : ''} · envelope containing fire activity, not burned area` : 'not yet available at selected time'}</small></span><em className="health-dot health-dot--amber" />
            </button>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="official" /><span><strong>Affected-area reports</strong><small>{frame.reportedAreaText} ha · {frame.areaLabel}</small></span><em className={`health-dot ${syncState.reportsComplete ? '' : 'health-dot--amber'}`} />
            </button>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone={frame.weatherSourceKind === 'station-observation' ? 'rmi' : 'weather'} /><span><strong>{frame.weatherSourceKind === 'station-observation' ? 'Mont Rigi station' : 'Wind model fallback'}</strong><small>{frame.weatherSourceKind === 'station-observation' ? `10 min observation · ${frame.weatherAgeMinutes} min old · awaiting RMI validation` : 'Open-Meteo hourly grid value'}</small></span><em className={`health-dot ${frame.weatherSourceKind === 'station-observation' ? 'health-dot--amber' : ''}`} />
            </button>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="adsb" /><span><strong>Aircraft</strong><small>{displayFlights.length} sourced set{importedTracks.length ? ` · ${importedTracks.length} static import` : ''}</small></span><em className="health-dot" /></button>
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
            fireOutlineRings={layers[FIRE_OUTLINE_KEY] ? fireOutlineRings : []}
            aircraftFireEdge={layers[FIRE_OUTLINE_KEY] ? aircraftSupportedEdge : null}
            mapLabels={runtime.mapLabels}
            protectedArea={runtime.protectedArea}
            officialPerimeter={runtime.officialPerimeter.current}
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
            timelineEvents={displayEvents}
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
                <article className="snapshot-card snapshot-card--estimate"><span><Flame size={15} /> BEST ESTIMATE</span><strong>{bestEstimateDetections.length ? Math.round(bestEstimateAreaHa).toLocaleString('en-GB') : '—'}<small>{bestEstimateDetections.length ? 'ha' : ''}</small></strong><p>{bestEstimateDetections.length ? `${bestEstimateDetections.length} selected thermal detections · ${bestEstimateCoreDetections.length} VIIRS${modisSupportedExtent.detections.length ? ` + ${modisSupportedExtent.detections.length} ${modisSupportedExtent.satellites.join('/')} MODIS` : ''}` : 'no qualifying detections yet'}</p></article>
                <article className="snapshot-card snapshot-card--effis"><span><Layers3 size={15} /> EFFIS DAILY GEOMETRY</span><strong>{currentEffisArea ? Math.round(currentEffisArea.areaHa).toLocaleString('en-GB') : '—'}<small>{currentEffisArea ? 'ha' : ''}</small></strong><p>{currentEffisArea ? `${currentEffisArea.productDate}${effisCarriedForward ? ' carried forward until replacement' : ''} · envelope containing fire activity, not burned area` : 'no EFFIS product available at selected time'}</p></article>
                <article className="snapshot-card"><span><Satellite size={15} /> HOTSPOTS</span><strong>{visibleFirmsDetections.length}<small>px</small></strong><p>shaded by confidence · exact NASA FIRMS detections</p></article>
                <article className="snapshot-card"><span><Helicopter size={15} /> AIR OPS</span><strong>{activeFlights.length}<small>recent</small></strong><p>{activeFlights.length ? 'fix within previous 5 min' : 'no recent observation'}</p></article>
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
                <div className="section-heading"><span>INCIDENT LOG</span><small>{displayEvents.filter((event) => event.frame <= frameIndex).length} visible</small></div>
                <div className="event-list">
                  {currentEvents.map((event, index) => {
                    const Icon = iconForEvent(event.type)
                    return (
                      // The source link sits outside the button: an anchor nested
                      // inside a button is invalid and unreachable by keyboard.
                      <div key={`${event.time}-${event.title}`} className="event-item">
                        <button className={`event-row ${index === 0 ? 'is-latest' : ''}`} type="button" onClick={() => setFrameIndex(event.frame)}>
                          <span className={`event-icon event-icon--${event.type}`}><Icon size={14} /></span>
                          <span>
                            <strong>{event.title}</strong>
                            <small>{event.detail}</small>
                            {event.affectedAreas?.length ? (
                              <small className="event-affected-areas">
                                <b>Named streets — </b>
                                {event.affectedAreas.map((area) => `${area.municipality}: ${area.streets.join(', ')}`).join(' · ')}
                              </small>
                            ) : null}
                          </span>
                          <time>{event.time}</time>
                        </button>
                        {event.sourceUrl ? (
                          <a className="event-source" href={event.sourceUrl} target="_blank" rel="noreferrer">
                            {event.sourceName ?? 'Source'} <ExternalLink size={10} />
                          </a>
                        ) : null}
                      </div>
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
                <p>{receiverObservedFlights.length} identified aircraft have exact incident-area receiver fixes{receiverObservedCallSigns ? `: ${receiverObservedCallSigns}` : ''}. G12 remains photo-confirmed only. Receiver positions establish proximity, not water pickups or drops.</p>
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

              <div className="coverage-note"><Radio size={15} /><p><strong>Dots are observations; dashed lines are not flight paths.</strong><span>Five-minute point checks discover verified and GRZLY incident aircraft without extra provider calls; trace reconciliation fills exact ADS-B/MLAT fixes missed between polls. Straight connectors appear only across gaps ≤2 minutes and plausible speed.</span></p></div>
              <div className="coverage-note"><Flame size={15} /><p><strong>The fire outline uses only repeated near-core GRZLY direction changes.</strong><span>Those evidence points enter on five-minute frames and are snapped to the same 50 m grid. Long reservoir-side and transit legs are excluded; the dashed extension is an inference, not a detected drop or confirmed fire front.</span></p></div>
              <div className="coverage-note"><Info size={15} /><p><strong>Wide-area checks separate this incident from nearby activity.</strong><span>{runtime.incidentAircraftMeta.negativeFindings?.[0]} {runtime.incidentAircraftMeta.negativeFindings?.[1]} The known Aachen/Walheim MLAT artifact is excluded.</span></p></div>
            </div>
          ) : null}
        </aside>
      </div>

      <DataModal
        open={dataOpen}
        onClose={() => setDataOpen(false)}
        onImportTracks={importTracks}
        importedCount={importedTracks.length}
        firmsState={firmsState}
        firmsDetectionCount={firmsData.detections.length}
        sourceLinks={runtime.sourceLinks}
        activeSources={runtime.sourceRegistry.sources}
        coverageGaps={runtime.sourceRegistry.coverageGaps}
        sourceRuns={sourceRuns}
        sentinel2={runtime.sentinel2}
      />
    </div>
  )
}

async function fetchDatabaseRuntime() {
  const response = await fetch('/api/data', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Database endpoint returned ${response.status}`)
  return runtimeDataFromResponse(await response.json())
}

// Start the first database read as soon as the application bundle executes.
// React can paint the shell while this request is in flight, and no incident
// payload is kept in the browser or bundled into the application.
let eagerRuntimeRequest = typeof window === 'undefined' ? null : fetchDatabaseRuntime()

function AsyncViewerShell({ databaseError, onRetry }) {
  const hasError = Boolean(databaseError)
  return (
    <div className="app-shell app-shell--hydrating" aria-busy={!hasError}>
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-mark"><Flame size={19} fill="currentColor" /></span>
          <div><strong>VENN</strong><small>FIRE WATCH</small></div>
        </div>

        <div className="incident-heading">
          <div className="incident-location"><Database size={14} /><b>LIVE INCIDENT VIEW</b></div>
          <span className="reference-badge"><Sparkles size={11} /> OBSERVATION VIEW</span>
        </div>

        <div className="header-actions">
          <div className="updated-state">
            <span className="live-pulse is-bundled" />
            <div>
              <small>{hasError ? 'DATABASE UNAVAILABLE' : 'SYNCING LIVE SOURCES'}</small>
              <strong>{hasError ? 'Retry available' : 'Opening viewer…'}</strong>
            </div>
          </div>
          <span className="data-button async-data-button" aria-hidden="true"><Database size={15} /><span>Data &amp; sources</span></span>
        </div>
      </header>

      <div className="workspace async-workspace">
        <aside className="left-sidebar async-sidebar" aria-hidden="true">
          <div className="incident-card async-incident-card">
            <span className="async-skeleton async-skeleton--tag" />
            <span className="async-skeleton async-skeleton--title" />
            <span className="async-skeleton async-skeleton--copy" />
            <div className="async-metrics"><span /><span /></div>
          </div>
          <div className="sidebar-section async-sidebar-section">
            <span className="async-skeleton async-skeleton--label" />
            <span className="async-skeleton async-skeleton--row" />
            <span className="async-skeleton async-skeleton--row" />
            <span className="async-skeleton async-skeleton--row" />
          </div>
          <div className="sidebar-section async-sidebar-section">
            <span className="async-skeleton async-skeleton--label" />
            <span className="async-skeleton async-skeleton--row" />
            <span className="async-skeleton async-skeleton--row" />
          </div>
        </aside>

        <main className="map-region async-map-region">
          <div className="map-fallback" aria-hidden="true">
            <i className="fallback-contour fallback-contour--one" />
            <i className="fallback-contour fallback-contour--two" />
            <i className="fallback-contour fallback-contour--three" />
          </div>
          {!hasError ? <span className="async-progress" aria-hidden="true" /> : null}
          <span className="sr-only" role="status">
            {hasError ? 'Live incident data is temporarily unavailable.' : 'Synchronizing live incident data.'}
          </span>
          {hasError ? (
            <div className="async-error" role="alert">
              <Database size={18} />
              <div>
                <strong>Live data is temporarily unavailable</strong>
                <p>The viewer has no bundled fallback. It will retry automatically, or you can retry now.</p>
              </div>
              <button type="button" onClick={onRetry}>Retry now</button>
            </div>
          ) : null}
          <div className="async-timeline" aria-hidden="true">
            <span className="async-skeleton async-skeleton--label" />
            <i />
          </div>
        </main>

        <aside className="right-inspector async-inspector" aria-hidden="true">
          <div className="inspector-tabs"><span>Situation</span><span>Air ops</span></div>
          <div className="async-inspector-body">
            <span className="async-skeleton async-skeleton--label" />
            <span className="async-skeleton async-skeleton--clock" />
            <div className="async-card-grid">
              {Array.from({ length: 6 }, (_, index) => <span key={index} />)}
            </div>
            <span className="async-skeleton async-skeleton--panel" />
          </div>
        </aside>
      </div>
    </div>
  )
}

function App() {
  const [runtime, setRuntime] = useState(null)
  const [databaseError, setDatabaseError] = useState(null)
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    let pending = false
    let initialRequest = eagerRuntimeRequest
    eagerRuntimeRequest = null

    async function refreshDatabaseView() {
      if (pending) return
      pending = true
      try {
        const request = initialRequest ?? fetchDatabaseRuntime()
        initialRequest = null
        const nextRuntime = await request
        if (!cancelled) {
          setRuntime(nextRuntime)
          setDatabaseError(null)
        }
      } catch (error) {
        if (!cancelled) setDatabaseError(error)
      } finally {
        pending = false
      }
    }

    refreshDatabaseView()
    const timer = window.setInterval(refreshDatabaseView, FIVE_MINUTES_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [retryCount])

  if (!runtime) {
    return <AsyncViewerShell databaseError={databaseError} onRetry={() => {
      setDatabaseError(null)
      setRetryCount((count) => count + 1)
    }} />
  }

  return <FireViewer runtime={runtime} databaseError={databaseError} />
}

export default App
