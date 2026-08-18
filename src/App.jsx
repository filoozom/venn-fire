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
  Ruler,
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
  AIRCRAFT_TRACE_LIFETIME_MS,
  aircraftCoverageWindows,
  visibleAircraftObservations,
} from './aircraftTracks'
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
// Best estimate is separate: its single solid outline follows fixed,
// documented satellite and repeat-supported aircraft selection rules.
const FIRMS_LAYER_KEYS = Object.fromEntries(FIRMS_SENSORS.map((sensor) => [sensor.key, `firms:${sensor.key}`]))
// Independent-satellite agreement, kept separate from the published confidence
// field. NASA's confidence value is never rewritten: a detection we cannot
// corroborate is still exactly what NASA reported it to be.
const FIRE_OUTLINE_KEY = 'fireOutline'
const ENVIRONMENT_LAYER_KEYS = Object.freeze({
  rmiRadar: 'rmiRadar',
  gibsFalseColor: 'gibsFalseColor',
  gibsTrueColor: 'gibsTrueColor',
  camsWildfirePm10: 'camsWildfirePm10',
  camsPm2p5: 'camsPm2p5',
  sentinel3Frp: 'sentinel3Frp',
})

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
const NON_DIRECTORY_SOURCE_KEYS = new Set([
  'aircraft-artifacts',
  'aircraft-traces',
  'aircraft-history',
  'aircraft-route-history',
  'firms-history',
  'effis-history-migration',
  'road-events',
  'official-perimeter',
  'public-operations',
])
const SOURCE_DIRECTORY_COPY = {
  aircraft: { label: 'Incident aircraft', coverage: 'Live positions and complete available routes for aircraft observed in the incident area.' },
  'open-meteo': { label: 'Open-Meteo weather model', coverage: 'Hourly forecast-model weather for the incident area.' },
  reports: { label: 'Governor and BRF reports', coverage: 'Published affected-area estimates and timestamped incident updates.' },
  'local-authority-updates': { label: 'Local-authority updates', coverage: 'Published incident notices from nearby municipalities, emergency services and police.' },
  vedia: { label: 'Vedia incident reporting', coverage: 'Incident reporting from the regional news service.' },
  'public-alerts': { label: 'BE-Alert public alerts', coverage: 'Public emergency alerts retained after they expire from the live feed.' },
  rmi: { label: 'RMI Mont Rigi observations', coverage: 'Ten-minute observations from Mont Rigi; newest values may await quality validation.' },
  'rmi-radar': { label: 'RMI precipitation radar', coverage: 'Official public precipitation-radar frames, retained and aligned to their observation times.' },
  'dwd-radar-history': { label: 'DWD precipitation-radar archive', coverage: 'Official 1 km precipitation amounts at five-minute granularity, retained from the start of the incident as each completed day is published.' },
  dwd: { label: 'DWD nearby wind stations', coverage: 'Ten-minute wind observations from nearby German stations.' },
  firms: { label: 'NASA FIRMS detections', coverage: 'Thermal detections from VIIRS, MODIS and Meteosat.' },
  'nasa-gibs': { label: 'NASA GIBS visual imagery', coverage: 'Daily VIIRS true-colour and short-wave-infrared visual context.' },
  effis: { label: 'Copernicus EFFIS activity envelope', coverage: 'Daily VIIRS-derived activity envelope; not an official burned-area perimeter.' },
  ems: { label: 'Copernicus EMS activations', coverage: 'Rapid Mapping activation catalogue and matching incident details when available.' },
  cams: { label: 'CAMS smoke and air quality', coverage: 'Hourly 0.1° model forecasts; wildfire-only PM10 is experimental and neither product is a local measurement.' },
  sentinel1: { label: 'Sentinel-1 radar acquisitions', coverage: 'Matched-platform and matched-orbit radar acquisitions for cloud-independent corroboration.' },
  sentinel2: { label: 'Sentinel-2 imagery and observed change', coverage: 'Cloud-masked before/after change evidence from 20 m Sentinel-2 imagery.' },
  'sentinel3-frp': { label: 'Sentinel-3 SLSTR NRT FRP', coverage: 'Near-real-time fire-radiative-power overpass records and retained visual previews.' },
}

function dwdWindLayerKey(stationId) {
  return `dwdWind:${stationId}`
}

function latestTimedRecord(rows, timeField, timestampMs, predicate = () => true) {
  return (rows ?? []).filter((row) => (
    predicate(row)
    && Number.isFinite(Date.parse(row?.[timeField]))
    && Date.parse(row[timeField]) <= timestampMs
  )).at(-1) ?? null
}

function latestDailyImage(rows, layerKey, timestampMs) {
  const selectedDate = new Date(timestampMs).toISOString().slice(0, 10)
  return (rows ?? []).filter((entry) => entry.layerKey === layerKey && entry.date <= selectedDate).at(-1) ?? null
}

function initialLayerState(runtime) {
  return {
    ...runtime.initialLayers,
    sentinel2BurnChange: true,
    [ENVIRONMENT_LAYER_KEYS.rmiRadar]: true,
    [ENVIRONMENT_LAYER_KEYS.gibsFalseColor]: false,
    [ENVIRONMENT_LAYER_KEYS.gibsTrueColor]: false,
    [ENVIRONMENT_LAYER_KEYS.camsWildfirePm10]: false,
    [ENVIRONMENT_LAYER_KEYS.camsPm2p5]: false,
    [ENVIRONMENT_LAYER_KEYS.sentinel3Frp]: true,
    ...FIRMS_LAYER_DEFAULTS,
    ...Object.fromEntries(runtime.dwdWindStations.map((station) => [dwdWindLayerKey(station.id), true])),
    [FIRE_OUTLINE_KEY]: true,
  }
}

function layerOptionsFor(
  effisArea,
  isCarriedForward,
  firmsSummaries = [],
  frame = null,
  dwdWindStations = [],
  sentinelAnalysis = null,
  environmental = {},
) {
  return [
  { key: 'perimeter', label: 'EFFIS activity envelope', detail: effisArea ? `${effisArea.productDate}${isCarriedForward ? ' carried forward' : ''} · ${Math.round(effisArea.areaHa).toLocaleString('en-GB')} ha envelope` : 'No product available at selected time', icon: Layers3, color: '#e96838' },
  {
    key: 'sentinel2BurnChange',
    label: 'Sentinel-2 observed change',
    detail: sentinelAnalysis
      ? `${sentinelAnalysis.supportCellCount.toLocaleString('en-GB')} supported 50 m cells · ${Math.round((sentinelAnalysis.clearFraction ?? 0) * 100)}% of crop cloud-clear · ${sentinelAnalysis.postScene?.acquiredAt?.slice(0, 10)}`
      : 'No usable post-fire image at selected time',
    icon: Satellite,
    color: '#7f55a5',
  },
  {
    key: ENVIRONMENT_LAYER_KEYS.sentinel3Frp,
    label: 'Sentinel-3 FRP detections',
    detail: environmental.sentinel3DetectionCount
      ? `${environmental.sentinel3DetectionCount.toLocaleString('en-GB')} published local detections at selected time`
      : `${environmental.sentinel3OverpassCount ?? 0} overpasses catalogued · no local detection coordinates in this view`,
    icon: Satellite,
    color: '#be3c83',
  },
  {
    key: ENVIRONMENT_LAYER_KEYS.rmiRadar,
    label: 'Precipitation radar',
    detail: environmental.rmiRadarFrame
      ? `${environmental.rmiRadarFrame.observedAt.slice(11, 16)} UTC · ${environmental.rmiRadarFrame.providerName ?? 'radar'} · incident: ${environmental.rmiRadarFrame.incident?.label ?? 'unavailable'}`
      : 'No radar observation available at selected time',
    icon: Droplets,
    color: '#356fae',
  },
  {
    key: ENVIRONMENT_LAYER_KEYS.gibsFalseColor,
    label: 'NASA VIIRS false colour',
    detail: environmental.gibsFalseColor ? `${environmental.gibsFalseColor.date} daily imagery` : 'No daily image available at selected time',
    icon: Satellite,
    color: '#9d5a42',
  },
  {
    key: ENVIRONMENT_LAYER_KEYS.gibsTrueColor,
    label: 'NASA VIIRS true colour',
    detail: environmental.gibsTrueColor ? `${environmental.gibsTrueColor.date} daily imagery` : 'No daily image available at selected time',
    icon: Eye,
    color: '#557b62',
  },
  {
    key: ENVIRONMENT_LAYER_KEYS.camsWildfirePm10,
    label: 'CAMS wildfire-only PM10 model',
    detail: environmental.camsWildfirePm10
      ? `${formatDecimal(environmental.camsWildfirePm10.point?.value, 1)} ${environmental.camsWildfirePm10.point?.unit ?? ''} forecast at the ~10 km model grid · ${environmental.camsWildfirePm10.validAt.slice(11, 16)} UTC · experimental`
      : 'No model frame available at selected time',
    icon: Wind,
    color: '#8b69b4',
  },
  {
    key: ENVIRONMENT_LAYER_KEYS.camsPm2p5,
    label: 'CAMS PM2.5 model',
    detail: environmental.camsPm2p5
      ? `${formatDecimal(environmental.camsPm2p5.point?.value, 1)} ${environmental.camsPm2p5.point?.unit ?? ''} forecast at the ~10 km model grid · ${environmental.camsPm2p5.validAt.slice(11, 16)} UTC`
      : 'No model frame available at selected time',
    icon: Wind,
    color: '#638db0',
  },
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
  { key: 'aircraft', label: 'Aircraft observations', detail: 'Exact fixes · linear 24 h fade', icon: Helicopter, color: '#3a7fcc' },
  { key: 'wind', label: 'Drossart model wind', detail: frame?.drossartWind ? `Open-Meteo hourly grid · ${frame.drossartWind.ageMinutes} min old` : 'No model value at selected time', icon: Wind, color: '#478fc4' },
  { key: 'rmiWind', label: 'Mont Rigi station wind', detail: frame?.montRigiWind ? `RMI 10 min observation · ${frame.montRigiWind.ageMinutes} min old · preliminary` : 'No station observation within 20 min of selected time', icon: Wind, color: '#4f9e90' },
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
const brusselsClockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Brussels',
  hour: '2-digit',
  minute: '2-digit',
})
const brusselsShortDateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Brussels',
  day: '2-digit',
  month: 'short',
})
const brusselsDateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Brussels',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function brusselsDateKey(timestampMs) {
  return brusselsDateKeyFormatter.format(new Date(timestampMs))
}

function observationTimeLabel(timestampMs, referenceTimestampMs = timestampMs) {
  if (!Number.isFinite(timestampMs)) return 'unknown time'
  const clock = brusselsClockFormatter.format(new Date(timestampMs))
  return brusselsDateKey(timestampMs) === brusselsDateKey(referenceTimestampMs)
    ? `${clock} CEST`
    : `${brusselsShortDateFormatter.format(new Date(timestampMs))} · ${clock} CEST`
}

function absoluteObservationTimeLabel(timestampMs) {
  if (!Number.isFinite(timestampMs)) return 'unknown time'
  return `${brusselsShortDateFormatter.format(new Date(timestampMs))} · ${brusselsClockFormatter.format(new Date(timestampMs))} CEST`
}

function sourceRunIsPartial(source) {
  return Boolean(
    source?.metadata?.failedProviders?.length
    || source?.metadata?.degradedProviders?.length
    || source?.metadata?.failedResponses?.length
    || source?.metadata?.complete === false,
  )
}

function normalizeDegrees(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return ((number % 360) + 360) % 360
}

function formatDegrees(value) {
  const normalized = normalizeDegrees(value)
  if (normalized == null) return '—'
  return `${Math.round(normalized) % 360}°`
}

function formatDecimal(value, maximumFractionDigits = 1) {
  if (value == null || value === '') return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return number.toLocaleString('en-GB', { maximumFractionDigits })
}

function radarProviderLabel(frame) {
  return frame?.providerName ?? (frame?.providerKey === 'dwd-radolan-yw' ? 'DWD RADOLAN YW' : 'RMI precipitation radar')
}

function radarStatusLabel(frame) {
  if (!frame) return 'AWAITING FRAME'
  if (frame.incident?.valueMm != null && Number.isFinite(Number(frame.incident.valueMm))) {
    return `${formatDecimal(frame.incident.valueMm, 2)} MM / 5 MIN`
  }
  return String(frame.incident?.label ?? 'AVAILABLE').toUpperCase()
}

function formatDistance(metres) {
  const value = Number(metres)
  if (!Number.isFinite(value) || value <= 0) return '0 m'
  return value < 1_000
    ? `${Math.round(value).toLocaleString('en-GB')} m`
    : `${(value / 1_000).toLocaleString('en-GB', { maximumFractionDigits: value < 10_000 ? 2 : 1 })} km`
}

function cadenceLabel(intervalMinutes) {
  if (intervalMinutes === 60) return 'Hourly'
  if (intervalMinutes > 60 && intervalMinutes % 60 === 0) return `Every ${intervalMinutes / 60} h`
  return `Every ${intervalMinutes} min`
}

function windCardinal(deg) {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  const normalized = normalizeDegrees(deg)
  return normalized == null ? '—' : names[Math.round(normalized / 22.5) % 16]
}

function observationState(flight, frame) {
  if (!flight.observations?.length) {
    const visibleEvidence = (flight.evidenceObservations || [])
      .filter((evidence) => evidence.timestampMs <= frame.timestampMs)
    if (flight.evidenceObservations?.length && !visibleEvidence.length) return { key: 'future', label: 'NOT YET' }
    if (visibleEvidence.length
      && frame.timestampMs - visibleEvidence.at(-1).timestampMs >= AIRCRAFT_TRACE_LIFETIME_MS) {
      return { key: 'expired', label: 'EXPIRED', latest: visibleEvidence.at(-1) }
    }
    if (visibleEvidence.at(-1)?.state === 'landed') return { key: 'landed', label: 'LANDED PHOTO', latest: visibleEvidence.at(-1) }
    return { key: 'static', label: 'STATIC' }
  }
  const visible = flight.observations.filter((observation) => observation.timestampMs <= frame.timestampMs)
  if (!visible.length) return { key: 'future', label: 'NOT YET' }
  const latest = visible.at(-1)
  if (frame.timestampMs - latest.timestampMs <= OBSERVATION_RECENCY_MS) {
    return { key: 'recent', label: 'OBSERVED', latest }
  }
  if (frame.timestampMs - latest.timestampMs >= AIRCRAFT_TRACE_LIFETIME_MS) {
    return { key: 'expired', label: 'EXPIRED', latest }
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
        <span className="reconstruction-note"><Info size={12} /> Paths join only adjacent, plausible source fixes; gaps stay open. Unverified low-altitude response candidates are labelled, not presented as confirmed missions.</span>
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

function sourceTone(sourceKey) {
  if (sourceKey === 'firms' || sourceKey === 'nasa-gibs') return 'nasa'
  if (sourceKey === 'effis' || sourceKey === 'ems' || sourceKey === 'sentinel1'
    || sourceKey === 'sentinel2' || sourceKey === 'sentinel3-frp' || sourceKey === 'cams') return 'effis'
  if (sourceKey === 'rmi-radar') return 'rmi'
  if (sourceKey.includes('meteo') || sourceKey === 'dwd' || sourceKey === 'dwd-radar-history' || sourceKey === 'rmi') return 'weather'
  if (sourceKey === 'reports' || sourceKey === 'vedia') return 'report'
  if (sourceKey === 'local-authority-updates' || sourceKey === 'public-alerts') return 'official'
  return 'adsb'
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
  sourceRuns = [],
  cams = { frames: [] },
  nasaGibs = { images: [] },
  rmiRadar = { frames: [] },
  sentinel1 = { scenes: [], matchedPairs: [] },
  sentinel2 = { scenes: [] },
  sentinel3Frp = { scenes: [], detections: [] },
}) {
  const [tab, setTab] = useState('connections')
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')
  const inputRef = useRef(null)
  const latestQuicklook = (sentinel2.scenes ?? []).filter((scene) => scene.quicklook?.stored).at(-1)
  const preFireQuicklook = sentinel2.lastPreFireScene?.quicklook?.stored ? sentinel2.lastPreFireScene : null
  const postFireQuicklook = sentinel2.firstPostFireScene?.quicklook?.stored ? sentinel2.firstPostFireScene : null
  const latestSentinelAnalysis = (sentinel2.analyses ?? []).filter((analysis) => analysis.status === 'ready').at(-1)
  const latestRmiRadar = (rmiRadar.frames ?? []).at(-1)
  const radarHistory = rmiRadar.historicalBackfill ?? { frameCount: 0, pendingDates: [] }
  const latestGibsFalseColor = (nasaGibs.images ?? []).filter((entry) => entry.layerKey === 'false-color').at(-1)
  const latestGibsTrueColor = (nasaGibs.images ?? []).filter((entry) => entry.layerKey === 'true-color').at(-1)
  const latestSentinel3Scene = (sentinel3Frp.scenes ?? []).filter((scene) => scene.thumbnail?.stored).at(-1)
  const sentinel1Scenes = new globalThis.Map((sentinel1.scenes ?? []).map((scene) => [scene.id, scene]))
  const latestSentinel1Pair = (sentinel1.matchedPairs ?? []).at(-1)
  const sentinel1PreScene = latestSentinel1Pair ? sentinel1Scenes.get(latestSentinel1Pair.preSceneId) : null
  const sentinel1PostScene = latestSentinel1Pair ? sentinel1Scenes.get(latestSentinel1Pair.postSceneId) : null
  const latestCamsWildfire = (cams.frames ?? []).filter((entry) => entry.productKey === 'wildfire-pm10').at(-1)
  const latestCamsPm2p5 = (cams.frames ?? []).filter((entry) => entry.productKey === 'pm2p5').at(-1)
  const sourceRunByKey = new globalThis.Map(sourceRuns.map((run) => [run.sourceKey, run]))
  const latestFirmsRun = sourceRunByKey.get('firms')
  const directorySources = activeSources
    .filter((source) => !NON_DIRECTORY_SOURCE_KEYS.has(source.key))
    .map((source) => ({ ...source, ...SOURCE_DIRECTORY_COPY[source.key] }))

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
            <span className="kicker">DATA &amp; SOURCES</span>
            <h2 id="data-modal-title">Data and source status</h2>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Close data and sources"><X size={19} /></button>
        </header>

        <nav className="modal-tabs" aria-label="Data and source sections">
          <button className={tab === 'connections' ? 'is-active' : ''} onClick={() => setTab('connections')} type="button">Overview</button>
          <button className={tab === 'method' ? 'is-active' : ''} onClick={() => setTab('method')} type="button">How to read this</button>
          <button className={tab === 'sources' ? 'is-active' : ''} onClick={() => setTab('sources')} type="button">Source directory</button>
        </nav>

        <div className="modal-content">
          {tab === 'connections' && (
            <>
              <div className="connection-card connection-card--primary">
                <div className="connection-icon"><Satellite size={20} /></div>
                <div className="connection-copy">
                  <div className="connection-title"><strong>NASA FIRMS</strong><span className="status-pill status-pill--connected"><Check size={11} /> AUTO-UPDATED</span></div>
                  <p>{firmsDetectionCount.toLocaleString('en-GB')} thermal detections from Suomi-NPP, NOAA-20, NOAA-21, Terra, Aqua and Meteosat are stored with their history. The current request returned {firmsState.currentWindowDetectionCount ?? '—'} detections; no newer detection is not confirmation that the fire is extinguished.</p>
                  <span className="connection-meta">Checked every 15 min{latestFirmsRun?.completedAt ? ` · feed checked ${absoluteObservationTimeLabel(Date.parse(latestFirmsRun.completedAt))}` : ''} · newest returned heat {firmsState.latestAcquiredAt ? absoluteObservationTimeLabel(Date.parse(firmsState.latestAcquiredAt)) : 'unavailable'}</span>
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
                    <span className="connection-title"><strong>Mont Rigi weather</strong><span className="status-pill status-pill--key">PRELIMINARY</span></span>
                    <p>Ten-minute measurements from RMI station 6494, 4.2 km from Drossart. The newest readings have not yet passed RMI quality validation.</p>
                    <span className="connection-meta">Official RMI station observations · Open-Meteo hourly model fallback</span>
                  </span>
                </div>

                <div className="connection-card connection-card--sentinel">
                  {preFireQuicklook && postFireQuicklook ? (
                    <span className="sentinel-comparison" aria-label="Sentinel-2 pre-fire and post-fire quicklook comparison">
                      <span><img className="sentinel-preview" src={preFireQuicklook.quicklook.databaseUrl} alt={`Pre-fire Sentinel-2 quicklook acquired ${preFireQuicklook.acquiredAt}`} /><b>BEFORE</b></span>
                      <span><img className="sentinel-preview" src={postFireQuicklook.quicklook.databaseUrl} alt={`Post-fire Sentinel-2 quicklook acquired ${postFireQuicklook.acquiredAt}`} /><b>AFTER</b></span>
                    </span>
                  ) : latestQuicklook ? (
                    <img className="sentinel-preview" src={latestQuicklook.quicklook.databaseUrl} alt={`Sentinel-2 quicklook acquired ${latestQuicklook.acquiredAt}`} />
                  ) : <span className="connection-icon"><Satellite size={20} /></span>}
                  <span className="connection-copy">
                    <span className="connection-title"><strong>Sentinel-2 observed change</strong><span className="status-pill status-pill--connected">{latestSentinelAnalysis ? `${latestSentinelAnalysis.supportCellCount.toLocaleString('en-GB')} CELLS` : `${sentinel2.storedQuicklookCount ?? 0} STORED`}</span></span>
                    <p>{latestSentinelAnalysis ? `The latest clear pixels show ${formatDecimal(latestSentinelAnalysis.observedChangeAreaHa)} ha of spectral change consistent with fire. They occupy ${formatDecimal(latestSentinelAnalysis.supportAreaHa)} ha on the shared 50 m display grid; ${Math.round(latestSentinelAnalysis.clearFraction * 100)}% of the crop was cloud-clear.` : latestQuicklook ? `Latest retained image: ${latestQuicklook.name}.` : 'The catalogue is synchronized; no public image has been stored yet.'}</p>
                    <span className="connection-meta">Near-infrared and short-wave infrared comparison · checked for new images every 5 min · analysed crop retained in PostgreSQL</span>
                  </span>
                </div>

                <div className="connection-card connection-card--sentinel connection-card--environmental">
                  {latestRmiRadar?.image?.databaseUrl ? (
                    <img className="sentinel-preview environmental-preview environmental-preview--radar" src={latestRmiRadar.image.databaseUrl} alt={`Precipitation radar observed ${latestRmiRadar.observedAt}`} />
                  ) : <span className="connection-icon connection-icon--weather"><Droplets size={20} /></span>}
                  <span className="connection-copy">
                    <span className="connection-title"><strong>Precipitation radar</strong><span className="status-pill status-pill--connected">{radarStatusLabel(latestRmiRadar)}</span></span>
                    <p>{latestRmiRadar ? `The newest retained frame is ${absoluteObservationTimeLabel(Date.parse(latestRmiRadar.observedAt))} from ${radarProviderLabel(latestRmiRadar)}; the incident reading is ${latestRmiRadar.incident?.label ?? 'unavailable'}.` : 'No public radar frame has been retained yet.'}</p>
                    <span className="connection-meta">RMI live animation retained on arrival · {radarHistory.frameCount.toLocaleString('en-GB')} DWD five-minute frames backfilled{radarHistory.pendingDates?.length ? ` · awaiting completed archive: ${radarHistory.pendingDates.join(', ')}` : ''} · all frames stored in PostgreSQL</span>
                  </span>
                </div>

                <div className="connection-card connection-card--sentinel connection-card--environmental">
                  {latestGibsFalseColor && latestGibsTrueColor ? (
                    <span className="sentinel-comparison" aria-label="NASA GIBS false-colour and true-colour imagery">
                      <span><img className="sentinel-preview" src={latestGibsFalseColor.image.databaseUrl} alt={`NASA VIIRS false colour ${latestGibsFalseColor.date}`} /><b>SWIR</b></span>
                      <span><img className="sentinel-preview" src={latestGibsTrueColor.image.databaseUrl} alt={`NASA VIIRS true colour ${latestGibsTrueColor.date}`} /><b>TRUE</b></span>
                    </span>
                  ) : <span className="connection-icon"><Eye size={20} /></span>}
                  <span className="connection-copy">
                    <span className="connection-title"><strong>NASA GIBS visual imagery</strong><span className="status-pill status-pill--connected">{latestGibsFalseColor?.date ?? 'AWAITING IMAGE'}</span></span>
                    <p>Daily VIIRS true colour provides smoke and cloud context; the M11/I2/I1 composite makes heat and surface change easier to inspect. Neither image is treated as a hotspot or perimeter measurement.</p>
                    <span className="connection-meta">Daily imagery checked every 30 min · distinct revisions retained in PostgreSQL</span>
                  </span>
                </div>

                <div className="connection-card connection-card--sentinel connection-card--environmental">
                  {latestSentinel3Scene?.thumbnail?.databaseUrl ? (
                    <img className="sentinel-preview" src={latestSentinel3Scene.thumbnail.databaseUrl} alt={`Sentinel-3 SLSTR preview acquired ${latestSentinel3Scene.acquiredAt}`} />
                  ) : <span className="connection-icon"><Satellite size={20} /></span>}
                  <span className="connection-copy">
                    <span className="connection-title"><strong>Sentinel-3 SLSTR NRT FRP</strong><span className="status-pill status-pill--connected">{(sentinel3Frp.scenes?.length ?? 0).toLocaleString('en-GB')} PASSES</span></span>
                    <p>{latestSentinel3Scene ? `Latest intersecting overpass: ${absoluteObservationTimeLabel(Date.parse(latestSentinel3Scene.acquiredAt))}. ${(sentinel3Frp.detections?.length ?? 0).toLocaleString('en-GB')} local FRP coordinates are currently available to plot.` : 'The near-real-time FRP catalogue is synchronized; no intersecting preview is stored yet.'}</p>
                    <span className="connection-meta">500 m SWIR / 1 km MWIR product · catalogue passes and previews do not become map detections by themselves</span>
                  </span>
                </div>

                <div className="connection-card connection-card--sentinel connection-card--environmental">
                  {sentinel1PreScene?.thumbnail?.stored && sentinel1PostScene?.thumbnail?.stored ? (
                    <span className="sentinel-comparison" aria-label="Matched Sentinel-1 radar acquisition previews">
                      <span><img className="sentinel-preview" src={sentinel1PreScene.thumbnail.databaseUrl} alt={`Sentinel-1 before acquisition ${sentinel1PreScene.acquiredAt}`} /><b>BEFORE</b></span>
                      <span><img className="sentinel-preview" src={sentinel1PostScene.thumbnail.databaseUrl} alt={`Sentinel-1 after acquisition ${sentinel1PostScene.acquiredAt}`} /><b>AFTER</b></span>
                    </span>
                  ) : <span className="connection-icon"><Satellite size={20} /></span>}
                  <span className="connection-copy">
                    <span className="connection-title"><strong>Sentinel-1 radar acquisitions</strong><span className="status-pill status-pill--connected">{(sentinel1.matchedPairs?.length ?? 0).toLocaleString('en-GB')} MATCHED</span></span>
                    <p>{latestSentinel1Pair ? `${latestSentinel1Pair.platform?.toUpperCase() ?? 'Sentinel-1'} relative orbit ${latestSentinel1Pair.relativeOrbit}, ${latestSentinel1Pair.orbitState}: ${latestSentinel1Pair.preAcquiredAt.slice(0, 10)} compared with ${latestSentinel1Pair.postAcquiredAt.slice(0, 10)}.` : 'No same-platform, same-orbit pre/post acquisition pair is catalogued yet.'} Preview images are context only and do not alter the Best estimate.</p>
                    <span className="connection-meta">Cloud-independent radar catalogue · checked hourly · conservative matched-orbit pairs retained</span>
                  </span>
                </div>

                <div className="connection-card connection-card--sentinel connection-card--environmental">
                  {latestCamsWildfire?.image?.databaseUrl ? (
                    <img className="sentinel-preview" src={latestCamsWildfire.image.databaseUrl} alt={`CAMS wildfire PM10 forecast valid ${latestCamsWildfire.validAt}`} />
                  ) : <span className="connection-icon connection-icon--weather"><Wind size={20} /></span>}
                  <span className="connection-copy">
                    <span className="connection-title"><strong>CAMS smoke and air quality</strong><span className="status-pill status-pill--connected">MODEL</span></span>
                    <p>{latestCamsWildfire ? `Incident model grid: ${formatDecimal(latestCamsWildfire.point?.value, 1)} ${latestCamsWildfire.point?.unit ?? ''} wildfire-only PM10${latestCamsPm2p5 ? ` and ${formatDecimal(latestCamsPm2p5.point?.value, 1)} ${latestCamsPm2p5.point?.unit ?? ''} PM2.5` : ''}, valid ${latestCamsWildfire.validAt.slice(0, 16).replace('T', ' ')} UTC. These are model forecasts, not local measurements.` : 'No CAMS forecast frame has been retained yet.'}</p>
                    <span className="connection-meta">Hourly Copernicus/ECMWF forecast · 0.1° grid (about 10 km) · wildfire-only PM10 is experimental · map colours saturate at 500 µg/m³</span>
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
                <p><strong>Different products answer different questions.</strong> Reported area, thermal detections, aircraft positions and weather remain separate. Only evidence that passes the stated rules contributes to the Best estimate.</p>
              </div>
              <div className="method-steps">
                <article><span>01</span><div><strong>Best estimate</strong><p>The solid red outline combines corroborated VIIRS heat observations available by the selected time, supported pixels from the newest MODIS pass, cloud-clear Sentinel-2 change near the fire, and tightly filtered aircraft evidence. All accepted evidence uses the same 50 m grid. The separate touched-zone layer remains removed, and Meteosat never changes the estimate.</p></div></article>
                <article><span>02</span><div><strong>Reported area</strong><p>The line is a timestamped step series. A figure becomes visible when published; when its stated effective time differs, both times are retained and shown. Between reports it means “last reported,” not measured growth.</p></div></article>
                <article><span>03</span><div><strong>EFFIS activity envelope</strong><p>EFFIS groups a day of VIIRS activity into a broad shape. Its calculated area can include ground between detections, so it is neither the reported affected area nor a field-confirmed perimeter.</p></div></article>
                <article><span>04</span><div><strong>Aircraft observations</strong><p>Routes use exact receiver fixes. Missing coverage stays missing, and routes fade away after 24 hours. An aircraft seen near the incident is not automatically a firefighting aircraft; only repeated, near-fire GRZLY manoeuvres can influence the Best estimate.</p></div></article>
                <article><span>05</span><div><strong>Environmental context</strong><p>Precipitation radar combines retained RMI live frames with five-minute DWD RADOLAN history and is visible by default; GIBS provides visual imagery; CAMS is an hourly ~10 km model forecast, not a local sensor. Its wildfire PM10 field is experimental and its colour ramp saturates at 500 µg/m³. Sentinel-3 catalogue passes and Sentinel-1 preview pairs remain context unless coordinate-level measurements pass the map and estimate rules.</p></div></article>
                <article><span>06</span><div><strong>Situation reports</strong><p>Published estimates appear from their stated time and link to the original source. BRF figures remain labelled as local reporting rather than official measurements.</p></div></article>
              </div>
              <div className="safety-note"><ShieldAlert size={17} /><span>This viewer is informational and must not be used for evacuation or preservation-of-life decisions. Follow BE-Alert and emergency services.</span></div>
            </div>
          )}

          {tab === 'sources' && (
            <div className="source-directory">
              <div className="directory-section-title">
                <strong>Live data sources</strong>
                <small>{directorySources.length} sources checked automatically</small>
              </div>
              {directorySources.map((source) => {
                const run = sourceRunByKey.get(source.key)
                const state = run?.status === 'failed' ? 'FAILED'
                    : run?.status === 'running' ? 'SYNCING'
                      : sourceRunIsPartial(run) ? 'PARTIAL'
                        : cadenceLabel(source.intervalMinutes)
                const content = (
                  <>
                    <SourceMark tone={sourceTone(source.key)} />
                    <span><strong>{source.label}</strong><small>{source.coverage}</small></span>
                    <em>{state}</em>
                    {source.providerUrl ? <ExternalLink size={15} /> : <CircleHelp size={15} />}
                  </>
                )
                return source.providerUrl ? (
                  <a key={source.key} href={source.providerUrl} target="_blank" rel="noreferrer" className="directory-row">{content}</a>
                ) : <div key={source.key} className="directory-row directory-row--inactive">{content}</div>
              })}
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
              <div className="source-footnote"><Database size={15} /><p>Current records and their history are stored in PostgreSQL. Source links open the original provider.</p></div>
              <div className="source-footnote"><CircleHelp size={15} /><p>Timestamped aircraft-track exports, georeferenced aerial imagery, or coordinate-level Sentinel-1/Sentinel-3 measurements could improve this record. <a href="https://apyos.com" target="_blank" rel="noreferrer">Contact us if you have access to this information.</a></p></div>
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
  const [measureMode, setMeasureMode] = useState(false)
  const [measurement, setMeasurement] = useState({ pointCount: 0, totalMetres: 0 })
  const firmsData = runtime.firms
  const firmsState = {
    status: databaseError ? 'stale' : 'live',
    configured: true,
    generatedAt: firmsData.generatedAt,
    latestAcquiredAt: firmsData.latestAcquiredAt,
    currentWindowDetectionCount: firmsData.currentWindowDetectionCount,
  }
  const liveAircraftObservations = runtime.aircraft.observations ?? []
  const aircraftLoadStatus = runtime.aircraftLoadState?.status || 'ready'
  const aircraftHistoryUnavailable = aircraftLoadStatus === 'error'
  const aircraftHistoryLoading = aircraftLoadStatus === 'loading'
  const sourceRuns = runtime.database?.sources ?? []
  const firmsSourceRun = sourceRuns.find((source) => source.sourceKey === 'firms')
  const publicSourceKeys = new Set((runtime.sourceRegistry.sources ?? [])
    .filter((source) => !NON_DIRECTORY_SOURCE_KEYS.has(source.key))
    .map((source) => source.key))
  const publicSourceRuns = sourceRuns.filter((source) => publicSourceKeys.has(source.sourceKey))
  const hasFailedSource = publicSourceRuns.some((source) => source.status === 'failed')
  const hasPartialSource = publicSourceRuns.some(sourceRunIsPartial)
  const syncState = {
    status: databaseError ? 'stale' : hasFailedSource || hasPartialSource || aircraftHistoryUnavailable ? 'partial' : 'live',
    generatedAt: runtime.generatedAt,
    weatherOk: true,
    aircraftOk: sourceRuns.find((source) => source.sourceKey === 'aircraft')?.status === 'ok'
      && !aircraftHistoryUnavailable,
    reportsOk: Boolean(runtime.reports.ok),
    reportsComplete: Boolean(runtime.reports.complete),
  }
  const frame = frames[Math.min(frameIndex, frames.length - 1)]
  const currentEffisArea = effisAreaForTimestamp(runtime.effisProducts, frame.timestampMs)
  // "Carried forward" means the product predates the day being viewed, not that
  // it happens to be the 14 August one. On 14 August that product is current.
  const effisCarriedForward = effisProductIsCarriedForward(currentEffisArea, frame.timestampMs)
    && frame.timestampMs >= Date.parse('2026-08-15T00:00:00+02:00')
  const visibleSentinelAnalyses = useMemo(() => (runtime.sentinel2.analyses ?? []).filter((analysis) => (
    analysis.status === 'ready' && Date.parse(analysis.acquiredAt) <= frame.timestampMs
  )), [runtime.sentinel2.analyses, frame.timestampMs])
  const currentSentinelAnalysis = visibleSentinelAnalyses.at(-1) ?? null
  const currentRmiRadar = useMemo(
    () => latestTimedRecord(runtime.rmiRadar.frames, 'observedAt', frame.timestampMs),
    [runtime.rmiRadar.frames, frame.timestampMs],
  )
  const currentGibsFalseColor = useMemo(
    () => latestDailyImage(runtime.nasaGibs.images, 'false-color', frame.timestampMs),
    [runtime.nasaGibs.images, frame.timestampMs],
  )
  const currentGibsTrueColor = useMemo(
    () => latestDailyImage(runtime.nasaGibs.images, 'true-color', frame.timestampMs),
    [runtime.nasaGibs.images, frame.timestampMs],
  )
  const currentCamsWildfirePm10 = useMemo(
    () => latestTimedRecord(runtime.cams.frames, 'validAt', frame.timestampMs, (entry) => entry.productKey === 'wildfire-pm10'),
    [runtime.cams.frames, frame.timestampMs],
  )
  const currentCamsPm2p5 = useMemo(
    () => latestTimedRecord(runtime.cams.frames, 'validAt', frame.timestampMs, (entry) => entry.productKey === 'pm2p5'),
    [runtime.cams.frames, frame.timestampMs],
  )
  const visibleSentinel3Detections = useMemo(() => (runtime.sentinel3Frp.detections ?? []).filter((detection) => (
    Number.isFinite(Date.parse(detection.acquiredAt)) && Date.parse(detection.acquiredAt) <= frame.timestampMs
  )), [runtime.sentinel3Frp.detections, frame.timestampMs])
  const sentinel3OverpassCount = useMemo(() => (runtime.sentinel3Frp.scenes ?? []).filter((scene) => (
    Number.isFinite(Date.parse(scene.acquiredAt)) && Date.parse(scene.acquiredAt) <= frame.timestampMs
  )).length, [runtime.sentinel3Frp.scenes, frame.timestampMs])
  const environmentalAtTime = useMemo(() => ({
    rmiRadarFrame: currentRmiRadar,
    gibsFalseColor: currentGibsFalseColor,
    gibsTrueColor: currentGibsTrueColor,
    camsWildfirePm10: currentCamsWildfirePm10,
    camsPm2p5: currentCamsPm2p5,
    sentinel3DetectionCount: visibleSentinel3Detections.length,
    sentinel3OverpassCount,
  }), [currentRmiRadar, currentGibsFalseColor, currentGibsTrueColor, currentCamsWildfirePm10, currentCamsPm2p5, visibleSentinel3Detections.length, sentinel3OverpassCount])
  const sentinelSupportCells = useMemo(() => {
    const unique = new globalThis.Map()
    visibleSentinelAnalyses.forEach((analysis) => (analysis.supportCells ?? []).forEach((cell) => {
      if (Array.isArray(cell) && cell.length === 2) unique.set(`${cell[0]}:${cell[1]}`, cell)
    }))
    return [...unique.values()]
  }, [visibleSentinelAnalyses])
  const sentinelBurnGeometry = useMemo(() => ({
    type: 'FeatureCollection',
    features: visibleSentinelAnalyses
      .filter((analysis) => analysis.geometry?.coordinates?.length)
      .map((analysis) => ({
        type: 'Feature',
        properties: {
          acquiredAt: analysis.acquiredAt,
          supportCellCount: analysis.supportCellCount,
          supportAreaHa: analysis.supportAreaHa,
          clearFraction: analysis.clearFraction,
          preSceneId: analysis.preScene?.id,
          postSceneId: analysis.postScene?.id,
        },
        geometry: analysis.geometry,
      })),
  }), [visibleSentinelAnalyses])
  const reportedAreaText = frame.reportedAreaText

  const displayFlights = useMemo(
    () => mergeIncidentFlights(runtime.flights, liveAircraftObservations),
    [liveAircraftObservations, runtime.flights],
  )
  const visibleDisplayFlights = useMemo(
    () => displayFlights.filter((flight) => observationState(flight, frame).key !== 'expired'),
    [displayFlights, frame],
  )
  const visibleImportedTracks = useMemo(
    () => importedTracks.filter((flight) => observationState(flight, frame).key !== 'expired'),
    [importedTracks, frame],
  )
  const receiverObservedFlights = visibleDisplayFlights.filter((flight) => (
    visibleAircraftObservations(flight.observations, frame.timestampMs).length
  ))
  const receiverObservedCallSigns = receiverObservedFlights.map((flight) => flight.callSign).join(', ')
  const selectedDayKey = brusselsDateKey(frame.timestampMs)
  const selectedDayStartMs = Date.parse(`${selectedDayKey}T00:00:00+02:00`)
  const selectedDayEndMs = selectedDayStartMs + 24 * 60 * 60 * 1_000
  const flightsSeenOnSelectedDay = receiverObservedFlights.flatMap((flight) => {
    const visibleObservations = visibleAircraftObservations(flight.observations, frame.timestampMs)
    const observations = visibleObservations.filter((observation) => (
        observation.timestampMs >= selectedDayStartMs
        && observation.timestampMs < selectedDayEndMs
      ))
    return observations.length
      ? [{ flight, observations, visibleObservations, latest: observations.at(-1) }]
      : []
  })
  const latestSelectedDayFlight = flightsSeenOnSelectedDay
    .slice()
    .sort((left, right) => right.latest.timestampMs - left.latest.timestampMs)[0] ?? null
  const latestRetainedFlight = receiverObservedFlights.flatMap((flight) => {
    const observations = visibleAircraftObservations(flight.observations, frame.timestampMs)
    return observations.length ? [{ flight, latest: observations.at(-1) }] : []
  }).sort((left, right) => right.latest.timestampMs - left.latest.timestampMs)[0] ?? null

  const showAircraftRoute = (observations) => {
    const positions = (observations || []).map((observation) => observation.position).filter(Boolean)
    if (!positions.length) return
    setLayers((current) => ({ ...current, aircraft: true }))
    mapActions?.fitPositions?.(positions)
  }

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
      if (event.key === 'Escape' && measureMode) {
        setMeasureMode(false)
        return
      }
      if (event.key === 'ArrowLeft') setFrameIndex((value) => Math.max(0, value - 1))
      if (event.key === 'ArrowRight') setFrameIndex((value) => Math.min(frames.length - 1, value + 1))
      if (event.key === ' ') {
        event.preventDefault()
        setPlaying((value) => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dataOpen, frames.length, measureMode])

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
      status: 'RMI · preliminary',
      color: '#8fd7c7',
      ...frame.montRigiWind,
    }] : []),
    ...(frame.dwdWinds || []).map((reading) => ({
      ...reading,
      distanceLabel: `${formatDecimal(reading.distanceKm)} km`,
      status: 'DWD · preliminary',
      color: '#b9a0e8',
    })),
  ], [frame])

  // Database-retained FIRMS detections, placed on the five-minute timeline by
  // exact acquisition time. Polar overpasses remain visible as timestamped
  // satellite evidence; only the instantaneous Meteosat scan expires.
  const firmsDetections = useMemo(() => firmsData.detections.map((detection) => {
    const sensor = FIRMS_SENSORS.find((entry) => entry.key === detection.sensorKey)
    return {
      ...detection,
      sensorName: sensor?.name ?? detection.sensorKey,
      sensorColor: sensor?.color ?? '#efaa3c',
      providesArea: sensor?.providesArea === true,
      displayMode: detection.displayMode ?? sensor?.displayMode ?? 'footprint',
      pixelSizeLabel: sensor?.pixelSizeLabel ?? detection.pixelSizeLabel ?? `${formatDecimal(detection.scanKm)} × ${formatDecimal(detection.trackKm)} km pixel`,
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
    () => corroborateDetections(firmsDetections.filter((detection) => firmsDetectionVisibleAt(detection, frame.timestampMs))),
    [firmsDetections, frame.timestampMs],
  )
  const currentFirmsSummaries = useMemo(() => (firmsData.sensors ?? []).map((summary) => ({
    ...summary,
    detectionCount: firmsDetectionsAtTime.filter((detection) => detection.sensorKey === summary.sensorKey).length,
  })), [firmsData.sensors, firmsDetectionsAtTime])
  const layerOptions = useMemo(
    () => layerOptionsFor(currentEffisArea, effisCarriedForward, currentFirmsSummaries, frame, runtime.dwdWindStations, currentSentinelAnalysis, environmentalAtTime),
    [currentEffisArea, effisCarriedForward, currentFirmsSummaries, frame, runtime.dwdWindStations, currentSentinelAnalysis, environmentalAtTime],
  )

  // The independently corroborated VIIRS core remains the anchor for both the
  // MODIS and aircraft selection rules.
  const bestEstimateCoreDetections = useMemo(
    () => firmsDetectionsAtTime.filter((detection) => detection.isFireCore),
    [firmsDetectionsAtTime],
  )

  // Seed the aircraft check with only thermal evidence available at the selected
  // time: the VIIRS core plus supported pixels from the newest MODIS pass.
  // This keeps the GRZLY edge integration without leaking future satellite
  // corroboration backward or restoring a separate touched-zone layer.
  const seedModisSupportedExtent = useMemo(() => deriveModisSupportedExtent({
    detections: firmsDetectionsAtTime,
    coreDetections: bestEstimateCoreDetections,
    aircraftEdgeCandidates: [],
    frameTimestampMs: frame.timestampMs,
    origin: firmsData.locationReference,
    gridCellM: MODIS_EXTENT_GRID_CELL_M,
    timeBucketMs: MODIS_EXTENT_TIME_BUCKET_MS,
  }), [firmsDetectionsAtTime, bestEstimateCoreDetections, frame.timestampMs, firmsData.locationReference])
  const aircraftReferenceCoreDetections = useMemo(
    () => [...bestEstimateCoreDetections, ...seedModisSupportedExtent.detections],
    [bestEstimateCoreDetections, seedModisSupportedExtent.detections],
  )
  const aircraftReferenceOutlineRings = useMemo(
    () => footprintOutlineRings(aircraftReferenceCoreDetections, {
      gridCellM: 50,
      origin: {
        latitude: firmsData.locationReference.latitude,
        longitude: firmsData.locationReference.longitude,
      },
    }),
    [aircraftReferenceCoreDetections, firmsData.locationReference],
  )

  const aircraftEstimateFlights = useMemo(() => visibleDisplayFlights.map((flight) => ({
    ...flight,
    observations: visibleAircraftObservations(flight.observations, frame.timestampMs)
      .filter((observation) => observation.routeScope !== 'full-route'),
  })).filter((flight) => flight.observations.length), [visibleDisplayFlights, frame.timestampMs])

  const aircraftSupportedEdge = useMemo(() => deriveAircraftSupportedEdge({
    flights: aircraftEstimateFlights,
    detections: aircraftReferenceCoreDetections,
    outlineRings: aircraftReferenceOutlineRings,
    frameTimestampMs: frame.timestampMs,
    origin: firmsData.locationReference,
    gridCellM: AIRCRAFT_EDGE_GRID_CELL_M,
    timeBucketMs: AIRCRAFT_EDGE_TIME_BUCKET_MS,
  }), [aircraftEstimateFlights, aircraftReferenceCoreDetections, aircraftReferenceOutlineRings, frame.timestampMs, firmsData.locationReference])

  const modisSupportedExtent = useMemo(() => deriveModisSupportedExtent({
    detections: firmsDetectionsAtTime,
    coreDetections: bestEstimateCoreDetections,
    aircraftEdgeCandidates: aircraftSupportedEdge.candidates,
    frameTimestampMs: frame.timestampMs,
    origin: firmsData.locationReference,
    gridCellM: MODIS_EXTENT_GRID_CELL_M,
    timeBucketMs: MODIS_EXTENT_TIME_BUCKET_MS,
  }), [firmsDetectionsAtTime, bestEstimateCoreDetections, aircraftSupportedEdge.candidates, frame.timestampMs, firmsData.locationReference])

  // There is one estimate, not separate satellite and aircraft outlines.
  // Qualifying MODIS pixels and the conservative repeat-supported aircraft lobe
  // extend the same 50 m raster union, solid boundary and hectare figure.
  const bestEstimateDetections = useMemo(
    () => [...bestEstimateCoreDetections, ...modisSupportedExtent.detections],
    [bestEstimateCoreDetections, modisSupportedExtent.detections],
  )
  const aircraftSupportPolygons = aircraftSupportedEdge.supportPolygons

  const fireOutlineRings = useMemo(
    () => footprintOutlineRings(bestEstimateDetections, {
      gridCellM: 50,
      origin: {
        latitude: firmsData.locationReference.latitude,
        longitude: firmsData.locationReference.longitude,
      },
      supportPolygons: aircraftSupportPolygons,
      supportCells: sentinelSupportCells,
    }),
    [bestEstimateDetections, aircraftSupportPolygons, sentinelSupportCells, firmsData.locationReference],
  )
  const visibleFirmsDetections = useMemo(() => firmsDetectionsAtTime.filter((detection) => (
    layers[FIRMS_LAYER_KEYS[detection.sensorKey]]
      && activeConfidenceLevels.includes(detection.confidence.label)
  )), [firmsDetectionsAtTime, layers, activeConfidenceLevels])

  const rasterOverlays = useMemo(() => [
    ...(layers[ENVIRONMENT_LAYER_KEYS.gibsFalseColor] && currentGibsFalseColor?.image?.databaseUrl ? [{
      id: `gibs-false-${currentGibsFalseColor.date}`,
      kind: 'gibs-false-color',
      url: currentGibsFalseColor.image.databaseUrl,
      bounds: runtime.nasaGibs.bounds,
      opacity: 0.72,
      attribution: 'NASA EOSDIS GIBS',
    }] : []),
    ...(layers[ENVIRONMENT_LAYER_KEYS.gibsTrueColor] && currentGibsTrueColor?.image?.databaseUrl ? [{
      id: `gibs-true-${currentGibsTrueColor.date}`,
      kind: 'gibs-true-color',
      url: currentGibsTrueColor.image.databaseUrl,
      bounds: runtime.nasaGibs.bounds,
      opacity: 0.72,
      attribution: 'NASA EOSDIS GIBS',
    }] : []),
    ...(layers[ENVIRONMENT_LAYER_KEYS.camsWildfirePm10] && currentCamsWildfirePm10?.image?.databaseUrl ? [{
      id: `cams-wildfire-${currentCamsWildfirePm10.validAt}`,
      kind: 'cams-wildfire-pm10',
      url: currentCamsWildfirePm10.image.databaseUrl,
      bounds: currentCamsWildfirePm10.bounds ?? runtime.cams.bounds,
      opacity: 0.44,
      attribution: runtime.cams.attribution,
    }] : []),
    ...(layers[ENVIRONMENT_LAYER_KEYS.camsPm2p5] && currentCamsPm2p5?.image?.databaseUrl ? [{
      id: `cams-pm2p5-${currentCamsPm2p5.validAt}`,
      kind: 'cams-pm2p5',
      url: currentCamsPm2p5.image.databaseUrl,
      bounds: currentCamsPm2p5.bounds ?? runtime.cams.bounds,
      opacity: 0.42,
      attribution: runtime.cams.attribution,
    }] : []),
    ...(layers[ENVIRONMENT_LAYER_KEYS.rmiRadar] && currentRmiRadar?.image?.databaseUrl ? [{
      id: `rmi-radar-${currentRmiRadar.observedAt}`,
      kind: 'rmi-radar',
      url: currentRmiRadar.image.databaseUrl,
      bounds: currentRmiRadar.bounds ?? runtime.rmiRadar.bounds,
      opacity: 0.74,
      attribution: currentRmiRadar.attribution ?? 'Royal Meteorological Institute of Belgium',
    }] : []),
  ], [layers, currentGibsFalseColor, currentGibsTrueColor, currentCamsWildfirePm10, currentCamsPm2p5, currentRmiRadar, runtime.nasaGibs.bounds, runtime.cams.bounds, runtime.cams.attribution, runtime.rmiRadar.bounds])

  // The estimate is the area of the exact 50 m raster union used by the solid
  // boundary, so the number and the map geometry cannot disagree.
  const bestEstimateArea = useMemo(() => estimateFootprintArea(bestEstimateDetections, {
    gridCellM: 50,
    origin: {
      latitude: firmsData.locationReference.latitude,
      longitude: firmsData.locationReference.longitude,
    },
    supportPolygons: aircraftSupportPolygons,
    supportCells: sentinelSupportCells,
  }), [bestEstimateDetections, aircraftSupportPolygons, sentinelSupportCells, firmsData.locationReference])
  const bestEstimateAreaHa = bestEstimateArea.unionHa
  const aircraftSupportIncluded = bestEstimateArea.polygonSupportCellCount > 0
  const sentinelSupportIncluded = sentinelSupportCells.length > 0

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
          <div className="updated-state"><span className={`live-pulse ${syncState.status === 'live' ? '' : 'is-bundled'}`} /><div><small>{syncState.status === 'live' ? 'LATEST DATA AVAILABLE' : syncState.status === 'partial' ? 'LATEST DATA · SOME SOURCES PARTIAL' : 'DATABASE VIEW STALE'}</small><strong>{frames.at(-1).dayLabel} · {frames.at(-1).shortTime} CEST</strong></div></div>
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
              <div><strong>{bestEstimateDetections.length ? Math.round(bestEstimateAreaHa).toLocaleString('en-GB') : '—'}</strong><span>best-estimate ha</span><small>{bestEstimateDetections.length ? `${bestEstimateCoreDetections.length} VIIRS core${modisSupportedExtent.detections.length ? ` + ${modisSupportedExtent.detections.length} ${modisSupportedExtent.satellites.join('/')} MODIS` : ''}${sentinelSupportIncluded ? ' + Sentinel-2 change' : ''}${aircraftSupportIncluded ? ` + ${aircraftSupportedEdge.callSigns.join('/')} aircraft evidence` : ''} · derived` : 'no qualifying satellite evidence at this time'}</small></div>
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
                <em>{bestEstimateDetections.length ? `${Math.round(bestEstimateAreaHa).toLocaleString('en-GB')} derived ha` : '—'}</em>
              </label>
            </div>
            <div className="outline-method-key" aria-label="Best estimate outline methods">
              <span><i className="is-satellite" /> Single combined outline</span>
            </div>
            <p className="layer-note">
              {bestEstimateDetections.length
                ? `One 50 m grid: ${bestEstimateCoreDetections.length} corroborated VIIRS detections${modisSupportedExtent.detections.length ? `, ${modisSupportedExtent.detections.length} high-confidence ${modisSupportedExtent.satellites.join('/')} MODIS pixels from the newest pass` : ''}${sentinelSupportIncluded ? `, ${currentSentinelAnalysis.supportCellCount.toLocaleString('en-GB')} clear Sentinel-2 change cells` : ''}${aircraftSupportIncluded ? `, and ${bestEstimateArea.polygonSupportCellCount} aircraft-supported cells from repeated ${aircraftSupportedEdge.callSigns.join(', ')} direction changes` : ''}. Evidence-based, not field-confirmed.${sentinelSupportIncluded ? ` Sentinel coverage: ${Math.round(currentSentinelAnalysis.clearFraction * 100)}%; obscured ground remains unknown.` : ''}${aircraftSupportIncluded ? ' Aircraft positions do not confirm a water drop.' : ''}`
                : 'No satellite detections available by this time meet the best-estimate rule.'}
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
            <div className="section-heading"><span>SOURCE STATUS</span><button type="button" onClick={() => setDataOpen(true)}>Details</button></div>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="nasa" /><span><strong>FIRMS</strong><small>{`${firmsData.detections.length} exact detections · ${visibleFirmsDetections.length} shown · newest heat ${firmsData.latestAcquiredAt ? observationTimeLabel(Date.parse(firmsData.latestAcquiredAt), frame.timestampMs) : 'unavailable'}${firmsSourceRun?.completedAt ? ` · feed checked ${observationTimeLabel(Date.parse(firmsSourceRun.completedAt), frame.timestampMs)}` : ''}`}</small></span><em className={`health-dot ${firmsState.status === 'live' ? '' : 'health-dot--amber'}`} />
            </button>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="rmi" /><span><strong>Precipitation radar</strong><small>{currentRmiRadar ? `${observationTimeLabel(Date.parse(currentRmiRadar.observedAt), frame.timestampMs)} · ${radarProviderLabel(currentRmiRadar)} · incident ${currentRmiRadar.incident?.label ?? 'unavailable'} · visible by default` : 'no radar observation at selected time'}</small></span><em className={`health-dot ${currentRmiRadar ? '' : 'health-dot--amber'}`} />
            </button>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="effis" /><span><strong>EFFIS activity envelope</strong><small>{currentEffisArea ? `${currentEffisArea.productDate}${effisCarriedForward ? ' carried forward' : ''} · contains fire activity but may include unaffected ground` : 'not yet available at selected time'}</small></span><em className="health-dot health-dot--amber" />
            </button>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="effis" /><span><strong>Sentinel-2 observed change</strong><small>{currentSentinelAnalysis ? `${currentSentinelAnalysis.postScene.acquiredAt.slice(0, 10)} · ${currentSentinelAnalysis.supportCellCount.toLocaleString('en-GB')} supported cells · ${Math.round(currentSentinelAnalysis.clearFraction * 100)}% of crop cloud-clear` : 'no usable post-fire image at selected time'}</small></span><em className={`health-dot ${currentSentinelAnalysis ? '' : 'health-dot--amber'}`} />
            </button>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="official" /><span><strong>Affected-area reports</strong><small>{frame.reportedAreaText} ha · {frame.areaLabel}</small></span><em className={`health-dot ${syncState.reportsComplete ? '' : 'health-dot--amber'}`} />
            </button>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone={frame.weatherSourceKind === 'station-observation' ? 'rmi' : 'weather'} /><span><strong>{frame.weatherSourceKind === 'station-observation' ? 'Mont Rigi station' : 'Wind model fallback'}</strong><small>{frame.weatherSourceKind === 'station-observation' ? `10 min observation · ${frame.weatherAgeMinutes} min old · preliminary` : 'Open-Meteo hourly grid value'}</small></span><em className={`health-dot ${frame.weatherSourceKind === 'station-observation' ? 'health-dot--amber' : ''}`} />
            </button>
            <button className="source-health-row" onClick={() => setDataOpen(true)} type="button">
              <SourceMark tone="adsb" /><span><strong>Aircraft</strong><small>{aircraftHistoryLoading
                ? 'Loading retained aircraft history asynchronously…'
                : aircraftHistoryUnavailable
                  ? 'Retained aircraft history is temporarily unavailable'
                  : `${flightsSeenOnSelectedDay.length} seen on selected day · ${visibleDisplayFlights.length} retained within 24 h${latestRetainedFlight ? ` · latest ${latestRetainedFlight.flight.callSign} ${observationTimeLabel(latestRetainedFlight.latest.timestampMs, frame.timestampMs)}` : ''}`}</small></span><em className={`health-dot ${syncState.aircraftOk && !aircraftHistoryLoading ? '' : 'health-dot--amber'}`} /></button>
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
            flights={visibleDisplayFlights}
            effisArea={currentEffisArea}
            effisCarriedForward={effisCarriedForward}
            layers={layers}
            baseMode={baseMode}
            onMapReady={setMapActions}
            importedTracks={visibleImportedTracks}
            firmsDetections={visibleFirmsDetections}
            rasterOverlays={rasterOverlays}
            measureMode={measureMode}
            onMeasurementChange={setMeasurement}
            sentinelBurnGeometry={layers.sentinel2BurnChange ? sentinelBurnGeometry : null}
            sentinel3Detections={layers[ENVIRONMENT_LAYER_KEYS.sentinel3Frp] ? visibleSentinel3Detections : []}
            fireOutlineRings={layers[FIRE_OUTLINE_KEY] ? fireOutlineRings : []}
            mapLabels={runtime.mapLabels}
            protectedArea={runtime.protectedArea}
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
            <p><strong>Official instructions take precedence</strong><span>This observation viewer does not determine current access or safety.</span></p>
            <a href="https://www.be-alert.be/en" target="_blank" rel="noreferrer">BE-Alert <ExternalLink size={12} /></a>
          </div>

          <div className="map-controls" aria-label="Map controls">
            <button type="button" onClick={() => mapActions?.zoomIn()} aria-label="Zoom in"><Plus size={18} /></button>
            <button type="button" onClick={() => mapActions?.zoomOut()} aria-label="Zoom out"><Minus size={18} /></button>
            <i />
            <button type="button" onClick={() => mapActions?.home()} aria-label="Show full incident area"><Maximize2 size={17} /></button>
            <button type="button" onClick={() => mapActions?.fire()} aria-label="Center on fire"><LocateFixed size={17} /></button>
            <i />
            <button className={measureMode ? 'is-active' : ''} type="button" onClick={() => setMeasureMode((value) => !value)} aria-label={measureMode ? 'Stop measuring distance' : 'Measure distance'} aria-pressed={measureMode}><Ruler size={17} /></button>
          </div>

          {(measureMode || measurement.pointCount > 0) && (
            <div className="map-measure-card" role="status" aria-live="polite">
              <Ruler size={16} />
              <div>
                <strong>{measurement.pointCount >= 2 ? formatDistance(measurement.totalMetres) : 'Measure distance'}</strong>
                <span>{measurement.pointCount === 0
                  ? 'Click the fire edge or another starting point'
                  : measurement.pointCount === 1
                    ? 'Click a city or destination'
                    : measureMode ? 'Click again to extend the route' : 'Straight-line map distance'}</span>
              </div>
              {measurement.pointCount > 0 && <button type="button" onClick={() => mapActions?.clearMeasurement?.()}>Clear</button>}
            </div>
          )}

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
            <button className={inspectorTab === 'air' ? 'is-active' : ''} onClick={() => setInspectorTab('air')} type="button">Aircraft <span>{visibleDisplayFlights.length + visibleImportedTracks.length}</span></button>
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
                <article className="snapshot-card snapshot-card--estimate"><span><Flame size={15} /> BEST ESTIMATE</span><strong>{bestEstimateDetections.length ? Math.round(bestEstimateAreaHa).toLocaleString('en-GB') : '—'}<small>{bestEstimateDetections.length ? 'ha' : ''}</small></strong><p>{bestEstimateDetections.length ? `${bestEstimateDetections.length} selected thermal detections · ${bestEstimateCoreDetections.length} VIIRS${modisSupportedExtent.detections.length ? ` + ${modisSupportedExtent.detections.length} ${modisSupportedExtent.satellites.join('/')} MODIS` : ''}${sentinelSupportIncluded ? ` · ${currentSentinelAnalysis.supportCellCount.toLocaleString('en-GB')} Sentinel-2 change cells` : ''}${aircraftSupportIncluded ? ` · ${bestEstimateArea.polygonSupportCellCount.toLocaleString('en-GB')} aircraft-supported cells` : ''}` : 'no qualifying satellite evidence at this time'}</p></article>
                <article className="snapshot-card snapshot-card--effis"><span><Layers3 size={15} /> EFFIS ACTIVITY ENVELOPE</span><strong>{currentEffisArea ? Math.round(currentEffisArea.areaHa).toLocaleString('en-GB') : '—'}<small>{currentEffisArea ? 'ha' : ''}</small></strong><p>{currentEffisArea ? `${currentEffisArea.productDate}${effisCarriedForward ? ' carried forward until replacement' : ''} · may include ground between detections` : 'no EFFIS product available at selected time'}</p></article>
                <article className="snapshot-card"><span><Satellite size={15} /> FIRMS DETECTIONS</span><strong>{visibleFirmsDetections.length.toLocaleString('en-GB')}</strong><p>retained up to selected time · shaded by reported confidence</p></article>
                <article className="snapshot-card"><span><Helicopter size={15} /> AIRCRAFT</span><strong>{aircraftHistoryLoading ? '—' : flightsSeenOnSelectedDay.length}<small>{aircraftHistoryLoading ? 'loading' : 'seen today'}</small></strong><p>{aircraftHistoryLoading
                  ? 'retained flight data is loading separately'
                  : aircraftHistoryUnavailable
                    ? 'retained flight data is temporarily unavailable'
                    : latestSelectedDayFlight
                      ? `latest ${latestSelectedDayFlight.flight.callSign} · ${observationTimeLabel(latestSelectedDayFlight.latest.timestampMs, frame.timestampMs)}`
                      : latestRetainedFlight
                        ? `none since midnight · latest retained ${latestRetainedFlight.flight.callSign} ${observationTimeLabel(latestRetainedFlight.latest.timestampMs, frame.timestampMs)}`
                        : 'no exact receiver fix within the last 24 hours'}</p></article>
                <article className="snapshot-card snapshot-card--wind"><span><Wind size={15} /> WIND FROM</span><strong>{windCardinal(frame.windDirection)}<small>{formatDegrees(frame.windDirection)}</small></strong><p>{formatDecimal(frame.windSpeed)} km/h · gust {formatDecimal(frame.gust)} · {frame.weatherSourceKind === 'station-observation' ? 'station obs.' : 'model'}</p></article>
              </div>

              <div className="conditions-card">
                <div className="section-heading"><span>FIRE WEATHER</span><small>{frame.weatherSourceKind === 'station-observation' ? `Mont Rigi · 10 min · ${frame.weatherAgeMinutes} min old` : 'Drossart · hourly model fallback'}</small></div>
                <div className="wind-hero">
                  <span className="big-wind-arrow" title={`Wind travelling toward ${formatDegrees(Number(frame.windDirection) + 180)}`}>
                    <svg viewBox="0 0 24 24" style={{ '--wind-rotation': `${normalizeDegrees(Number(frame.windDirection) + 180) ?? 0}deg` }} aria-hidden="true">
                      <path d="M12 20V4M6.5 9.5 12 4l5.5 5.5" />
                    </svg>
                  </span>
                  <div><strong>{windCardinal(frame.windDirection)}</strong><span>from {formatDegrees(frame.windDirection)} · blowing toward {formatDegrees(Number(frame.windDirection) + 180)}</span></div>
                  <p><strong>{formatDecimal(frame.windSpeed)}</strong><span>km/h</span><small>gusts {formatDecimal(frame.gust)}</small></p>
                </div>
                <div className="condition-row">
                  <span><ThermometerSun size={15} /> Temperature<strong>{formatDecimal(frame.temperature)}°C</strong></span>
                  <span><Droplets size={15} /> Humidity<strong>{formatDecimal(frame.humidity)}%</strong></span>
                </div>
                <p className={`weather-provenance ${frame.weatherSourceKind === 'station-observation' ? 'is-unvalidated' : ''}`}>
                  {frame.weatherSourceKind === 'station-observation'
                    ? `RMI station 6494, ${formatDecimal(frame.weatherStationDistanceKm)} km from Drossart. Preliminary near-real-time measurement; conditions at the fire may differ.`
                    : 'Open-Meteo model-grid fallback, not a station measurement.'}
                </p>
                <div className="wind-source-comparison">
                  <div className="wind-source-comparison__head"><strong>Nearby wind sources</strong><small>independent · never blended</small></div>
                  {nearbyWindReadings.map((reading) => (
                    <div className="wind-source-reading" key={reading.id}>
                      <span className="wind-source-reading__arrow" style={{ '--source-color': reading.color, '--wind-rotation': `${normalizeDegrees(Number(reading.windDirection) + 180) ?? 0}deg` }}>
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V4M6.5 9.5 12 4l5.5 5.5" /></svg>
                      </span>
                      <span><strong>{reading.name}</strong><small>{reading.distanceLabel} · {reading.status}</small></span>
                      <span><strong>{windCardinal(reading.windDirection)} <small>from {formatDegrees(reading.windDirection)}</small></strong><small>{formatDecimal(reading.windSpeed)} km/h · {reading.ageMinutes} min old</small></span>
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
                <h2>Aircraft observations</h2>
                <p>{aircraftHistoryLoading
                  ? 'Retained aircraft fixes are loading asynchronously; the incident map and other live sources are already usable.'
                  : aircraftHistoryUnavailable
                    ? 'Retained aircraft fixes are temporarily unavailable. Provider polling continues in the database and this view will retry.'
                    : `${flightsSeenOnSelectedDay.length} aircraft were seen on the selected day; ${receiverObservedFlights.length} remain visible inside the 24-hour window${receiverObservedCallSigns ? `: ${receiverObservedCallSigns}` : ''}. Plausible candidates are labelled separately. G12 remains photo-confirmed only. Receiver positions establish proximity, not water pickups or drops.`}</p>
                <div className="air-ops-actions">
                  <button
                    type="button"
                    disabled={!flightsSeenOnSelectedDay.length}
                    onClick={() => showAircraftRoute(flightsSeenOnSelectedDay.flatMap((entry) => entry.visibleObservations))}
                  ><LocateFixed size={14} /> Show selected-day flight sessions</button>
                  <button type="button" onClick={() => setDataOpen(true)}><FileUp size={14} /> Import tracks</button>
                </div>
              </div>

              <div className="flight-list">
                {[...visibleDisplayFlights, ...visibleImportedTracks].map((flight) => {
                  const state = observationState(flight, frame)
                  const isActive = state.key === 'recent'
                  const hasStarted = !['future'].includes(state.key)
                  const visibleObservations = flight.observations
                    ? visibleAircraftObservations(flight.observations, frame.timestampMs)
                    : null
                  const observationCount = visibleObservations?.length ?? null
                  const selectedDayObservationCount = visibleObservations?.filter((observation) => (
                    observation.timestampMs >= selectedDayStartMs
                    && observation.timestampMs < selectedDayEndMs
                  )).length ?? null
                  const coverageCount = visibleObservations
                    ? aircraftCoverageWindows(visibleObservations).length
                    : null
                  const photoCount = flight.evidenceObservations?.filter((evidence) => (
                    evidence.kind === 'photo'
                    && evidence.timestampMs <= frame.timestampMs
                    && frame.timestampMs - evidence.timestampMs < AIRCRAFT_TRACE_LIFETIME_MS
                  )).length ?? 0
                  return (
                    <article key={flight.id} className={`flight-card ${isActive ? 'is-active' : ''} ${hasStarted ? '' : 'is-future'}`}>
                      <div className="flight-head">
                        <span className="flight-icon" style={{ '--flight-color': flight.color }}>{flight.type === 'plane' ? <Plane size={17} /> : <Helicopter size={17} />}</span>
                        <div><strong>{flight.callSign}</strong><small>{flight.label}</small></div>
                        <span className={`flight-state ${isActive ? 'is-live' : ''}`}>{state.latest ? observationTimeLabel(state.latest.timestampMs, frame.timestampMs) : state.label}</span>
                      </div>
                      <div className="flight-stats"><span><small>24 H FIXES</small><strong>{observationCount ?? '—'}</strong></span><span><small>SELECTED DAY</small><strong>{selectedDayObservationCount ?? '—'}</strong></span><span><small>CLUSTERS</small><strong>{coverageCount ?? '—'}</strong></span><span><small>PHOTOS</small><strong>{photoCount || '—'}</strong></span></div>
                      <div className="flight-provenance"><Info size={12} /> {flight.status}{flight.pathMethod ? ` · ${flight.pathMethod}` : ''}</div>
                      {visibleObservations?.length ? (
                        <div className="flight-actions">
                          <button type="button" onClick={() => showAircraftRoute(visibleObservations)}><MapPin size={12} /> Show complete visible route</button>
                        </div>
                      ) : null}
                    </article>
                  )
                })}
              </div>

              <div className="coverage-note"><Radio size={15} /><p><strong>Qualified aircraft routes fade for 24 hours.</strong><span>After an aircraft enters the incident area, its complete available provider route is shown from the first to last receiver-supported fix. This can approach takeoff and landing, but transponder or coverage gaps are not invented. Every fix and gap-limited connector fades against the selected five-minute frame, then disappears completely at 24 hours; PostgreSQL retains the source history.</span></p></div>
              <div className="coverage-note"><Flame size={15} /><p><strong>Qualifying aircraft evidence extends the same solid Best estimate outline.</strong><span>Repeated GRZLY direction changes must remain within 1 km of the thermal core and within 900 m of another five-minute evidence frame. Each local cluster bounds its own compact lobe on the shared 50 m raster, so approach, reservoir and disconnected route legs cannot be bridged into the outline. Receiver positions do not prove a drop or confirmed fire front.</span></p></div>
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
        sourceRuns={sourceRuns}
        cams={runtime.cams}
        nasaGibs={runtime.nasaGibs}
        rmiRadar={runtime.rmiRadar}
        sentinel1={runtime.sentinel1}
        sentinel2={runtime.sentinel2}
        sentinel3Frp={runtime.sentinel3Frp}
      />
    </div>
  )
}

async function fetchDatabaseResponse(scope) {
  const response = await fetch(`/api/data?scope=${encodeURIComponent(scope)}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Database endpoint returned ${response.status}`)
  return response.json()
}

async function fetchCoreRuntime() {
  const response = await fetchDatabaseResponse('core')
  return { response, runtime: runtimeDataFromResponse(response) }
}

function runtimeWithAircraft(coreResponse, aircraftDataset, aircraftLoadState) {
  const response = aircraftDataset
    ? { ...coreResponse, datasets: { ...coreResponse.datasets, aircraft: aircraftDataset } }
    : coreResponse
  return { ...runtimeDataFromResponse(response), aircraftLoadState }
}

// Start the first database read as soon as the application bundle executes.
// Core incident data renders first; the much larger retained aircraft history
// follows asynchronously. No incident payload is bundled into the application.
let eagerRuntimeRequest = typeof window === 'undefined' ? null : fetchCoreRuntime()

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
          <div className="inspector-tabs"><span>Situation</span><span>Aircraft</span></div>
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
  const aircraftDatasetRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    let pending = false
    let initialRequest = eagerRuntimeRequest
    eagerRuntimeRequest = null

    async function refreshDatabaseView() {
      if (pending) return
      pending = true
      try {
        const request = initialRequest ?? fetchCoreRuntime()
        initialRequest = null
        const { response: coreResponse, runtime: coreRuntime } = await request
        if (!cancelled) {
          setRuntime(aircraftDatasetRef.current
            ? runtimeWithAircraft(coreResponse, aircraftDatasetRef.current, { status: 'refreshing' })
            : { ...coreRuntime, aircraftLoadState: { status: 'loading' } })
          setDatabaseError(null)
        }

        try {
          const aircraftResponse = await fetchDatabaseResponse('aircraft')
          const aircraftDataset = aircraftResponse.datasets?.aircraft
          if (!aircraftDataset) throw new Error('Aircraft database dataset is unavailable')
          aircraftDatasetRef.current = aircraftDataset
          if (!cancelled) {
            setRuntime(runtimeWithAircraft(coreResponse, aircraftDataset, { status: 'ready' }))
          }
        } catch (error) {
          if (!cancelled) {
            setRuntime((current) => current
              ? { ...current, aircraftLoadState: { status: 'error', message: error.message } }
              : current)
          }
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
