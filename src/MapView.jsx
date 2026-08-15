import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  AIRCRAFT_PATH_MAX_GAP_MS,
  AIRCRAFT_PATH_MAX_SPEED_KT,
} from './data'

// Detections are shaded by NASA's published confidence rather than by satellite:
// what matters when reading the map is how sure the observation is, not which
// spacecraft made it. Lower confidence is paler and more transparent.
const FIRMS_CONFIDENCE_STYLE = {
  high: { color: '#c2321f', weight: 0.9, opacity: 0.80, fillOpacity: 0.30 },
  nominal: { color: '#e07a4b', weight: 0.7, opacity: 0.45, fillOpacity: 0.15 },
  low: { color: '#e8b48c', weight: 0.6, opacity: 0.28, fillOpacity: 0.07 },
  unknown: { color: '#c9b8a8', weight: 0.5, opacity: 0.22, fillOpacity: 0.05 },
}

const OBSERVATION_RECENCY_MS = 5 * 60 * 1000
const INCIDENT_MAP_BOUNDS = [[50.49, 5.975], [50.575, 6.145]]
const INCIDENT_MAP_PADDING = {
  paddingTopLeft: [18, 72],
  paddingBottomRight: [18, 190],
}

function haversineKm(left, right) {
  const radians = Math.PI / 180
  const deltaLat = (right.position[0] - left.position[0]) * radians
  const deltaLon = (right.position[1] - left.position[1]) * radians
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(left.position[0] * radians) * Math.cos(right.position[0] * radians) * Math.sin(deltaLon / 2) ** 2
  return 6371.0088 * 2 * Math.asin(Math.sqrt(value))
}

function plausibleObservationLinks(
  observations,
  maxGapMs = AIRCRAFT_PATH_MAX_GAP_MS,
  maxSpeedKt = AIRCRAFT_PATH_MAX_SPEED_KT,
) {
  return observations.slice(1).flatMap((observation, index) => {
    const previous = observations[index]
    const elapsedMs = observation.timestampMs - previous.timestampMs
    if (elapsedMs <= 0 || elapsedMs > maxGapMs) return []
    const impliedSpeedKt = haversineKm(previous, observation) / 1.852 / (elapsedMs / 3_600_000)
    if (impliedSpeedKt > maxSpeedKt) return []
    return [{ previous, observation, impliedSpeedKt }]
  })
}

const basemaps = {
  terrain: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
      className: 'terrain-tiles',
    },
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri',
      className: 'satellite-tiles',
    },
  },
  topo: {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    options: {
      maxZoom: 17,
      attribution: 'Map data &copy; OpenStreetMap, SRTM | Map style &copy; OpenTopoMap',
      className: 'topo-tiles',
    },
  },
}

function windCardinal(deg) {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  return names[Math.round(deg / 22.5) % 16]
}

function windMapIcon({ label, wind, accent }) {
  return L.divIcon({
    className: 'wind-source-marker',
    html: `<span style="--wind-accent:${accent}"><svg viewBox="0 0 24 24" style="--wind-rotation:${(wind.windDirection + 180) % 360}deg" aria-hidden="true"><path d="M12 20V4M6.5 9.5 12 4l5.5 5.5"/></svg><b>${label}</b></span>`,
    iconSize: [42, 42],
    iconAnchor: [21, 21],
  })
}

function windTooltip({ name, wind, source, status, distanceKm = 0 }) {
  const gust = Number.isFinite(wind.gust) ? ` · gust ${wind.gust.toFixed(1)} km/h` : ''
  return `<strong>${escapeHtml(name)}</strong><br>`
    + `Wind from ${windCardinal(wind.windDirection)} (${wind.windDirection.toFixed(0)}°), blowing toward ${windCardinal((wind.windDirection + 180) % 360)}<br>`
    + `${wind.windSpeed.toFixed(1)} km/h${gust} · ${wind.ageMinutes} min old<br>`
    + `<small>${escapeHtml(source)}${distanceKm ? ` · ${distanceKm.toFixed(1)} km from Drossart` : ''}${status ? ` · ${escapeHtml(status)}` : ''}</small>`
}

function aircraftIcon(flight, heading = 0) {
  const planePath = '<path d="M12 2l2 7 7 3v2l-7-1.5V18l2 2v1l-4-1-4 1v-1l2-2v-5.5L3 14v-2l7-3 2-7z" fill="currentColor"/>'
  const helicopterPath = '<path d="M3 7.5h18M12 7.5V5m-1-1h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M8.5 9h7.4c1.7 0 3.1 1.3 3.1 3v.5H8.5a3.5 3.5 0 010-7h2v3.5z" fill="currentColor"/><path d="M8 13.5l-2 3m9-3 2 3M4.5 17h13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
  return L.divIcon({
    className: 'aircraft-map-marker',
    html: `<span style="--flight-color:${flight.color};--aircraft-rotation:${heading}deg"><svg viewBox="0 0 24 24" aria-hidden="true">${flight.type === 'plane' ? planePath : helicopterPath}</svg></span>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  })
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character])
}

function localObservationTime(timestamp) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Brussels',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp))
}

export default function MapView({
  frameIndex,
  frame,
  flights = [],
  effisArea = null,
  effisCarriedForward = false,
  layers,
  baseMode,
  onMapReady,
  importedTracks = [],
  firmsDetections = [],
  fireOutlineRings = [],
  mapLabels = [],
  protectedArea = [],
}) {
  const nodeRef = useRef(null)
  const mapRef = useRef(null)
  const tileRef = useRef(null)
  const overlayRef = useRef(null)
  const labelsRef = useRef(null)

  useEffect(() => {
    if (!nodeRef.current || mapRef.current) return undefined

    const map = L.map(nodeRef.current, {
      zoomControl: false,
      attributionControl: true,
      minZoom: 9,
      maxZoom: 18,
      zoomSnap: 0.25,
      preferCanvas: true,
    })
    map.fitBounds(INCIDENT_MAP_BOUNDS, INCIDENT_MAP_PADDING)
    mapRef.current = map
    overlayRef.current = L.layerGroup().addTo(map)
    labelsRef.current = L.layerGroup().addTo(map)

    const tile = L.tileLayer(basemaps[baseMode].url, basemaps[baseMode].options).addTo(map)
    tileRef.current = tile

    const home = () => map.fitBounds(INCIDENT_MAP_BOUNDS, INCIDENT_MAP_PADDING)
    onMapReady?.({
      zoomIn: () => map.zoomIn(0.75),
      zoomOut: () => map.zoomOut(0.75),
      home,
      fire: () => map.flyToBounds(L.latLngBounds(effisArea?.rings?.[0] || INCIDENT_MAP_BOUNDS), {
        paddingTopLeft: [35, 95],
        paddingBottomRight: [35, 185],
        maxZoom: 14,
        duration: 0.8,
      }),
    })

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (tileRef.current) map.removeLayer(tileRef.current)
    tileRef.current = L.tileLayer(basemaps[baseMode].url, basemaps[baseMode].options).addTo(map)
    tileRef.current.bringToBack()
  }, [baseMode])

  useEffect(() => {
    const group = labelsRef.current
    if (!group) return
    group.clearLayers()

    mapLabels.forEach((label) => {
      const icon = L.divIcon({
        className: `map-place-label map-place-label--${label.kind}`,
        html: `<span>${label.name}</span>`,
        iconAnchor: [0, 0],
      })
      L.marker(label.position, { icon, interactive: false }).addTo(group)
    })

  }, [mapLabels])

  useEffect(() => {
    const group = overlayRef.current
    if (!group) return
    group.clearLayers()

    // The Drossart marker was removed: it plotted the place name used in the
    // incident reports, not a fire measurement, and read as an ignition point.
    // The database incident center remains the measurement datum for distances.

    if (layers.protected && protectedArea.length >= 3) {
      L.polygon(protectedArea, {
        color: '#77a878',
        fillColor: '#4f7855',
        weight: 1.2,
        opacity: 0.75,
        fillOpacity: 0.10,
        dashArray: '5 6',
        interactive: true,
      })
        .bindTooltip('<strong>High Fens protected area</strong><br><span>Indicative northern reserve extent</span>', { direction: 'top' })
        .addTo(group)
    }

    if (layers.perimeter && effisArea) {
      L.polygon(effisArea.rings, {
        className: 'fire-perimeter-glow',
        color: '#d98a3b',
        fillColor: '#d98a3b',
        weight: 6,
        opacity: 0.10,
        fillOpacity: 0.025,
        interactive: false,
      }).addTo(group)

      L.polygon(effisArea.rings, {
        className: 'fire-perimeter-line',
        color: '#d48b3a',
        fillColor: '#d48b3a',
        weight: 2.4,
        opacity: 0.90,
        fillOpacity: 0.07,
        dashArray: '8 5',
      })
        .bindPopup(`<div class="map-popup"><span class="eyebrow">COPERNICUS EFFIS · VIIRS NRT</span><strong>${Math.round(effisArea.areaHa).toLocaleString('en-GB')} ha algorithmic geometry</strong><small>${effisArea.productLabel}${effisCarriedForward ? ' · carried forward as last available product' : ''} · ${effisArea.nominalResolutionM} m nominal sensor pixels</small><small>An <strong>envelope containing fire activity</strong>, not a burned area. EFFIS dissolves VIIRS detection pixels into one polygon, so unburned ground between detections is enclosed. EFFIS does not use this product for burned-area statistics.</small><small>Calculated from the WFS polygon; not field-confirmed and not synchronized within the day.</small><small>Separate reporting at this selected time: ${frame.reportedAreaText} ha (${frame.areaLabel}).</small><a href="${effisArea.sourceRequestUrl}" target="_blank" rel="noreferrer">Open source WFS GeoJSON</a><a href="https://forest-fire.emergency.copernicus.eu/apps/effis.csv/?c=629562.19,6608535.18&amp;z=8.544845581054688&amp;t=sentinel2" target="_blank" rel="noreferrer">Open EFFIS viewer</a></div>`)
        .bindTooltip(`<strong>EFFIS VIIRS-derived daily geometry</strong><br>${Math.round(effisArea.areaHa).toLocaleString('en-GB')} ha calculated polygon area · ${effisArea.productLabel}<br><small>Algorithmic envelope, not the official affected-area estimate</small>`, { sticky: true })
        .addTo(group)

    }

    // Sensor pixel footprints at their true published size, shaded by confidence.
    // The blockiness is the point: it shows the resolution the estimate is built
    // from, so no false precision can be read off the map.
    firmsDetections.forEach((detection) => {
      const style = FIRMS_CONFIDENCE_STYLE[detection.confidence.label] ?? FIRMS_CONFIDENCE_STYLE.unknown
      const age = frameIndex - detection.frame
      L.polygon(detection.footprint, {
        color: style.color,
        weight: style.weight,
        opacity: style.opacity,
        fillColor: style.color,
        fillOpacity: Math.max(style.fillOpacity * 0.4, style.fillOpacity - age * 0.004),
      })
        .bindTooltip(
          `<strong>${detection.confidence.label} confidence</strong><br>`
          + `${detection.sensorName} · ${detection.frpMw ?? '—'} MW FRP<br>`
          + `${Math.round(detection.scanKm * detection.trackKm * 100)} ha sensor pixel`
          + `${detection.corroboratingSensors > 1 ? `<br>${detection.corroboratingSensors} satellites saw this cell` : ''}`
          + `<br><small>NASA FIRMS · ${detection.acquiredAt.replace('T', ' ').slice(0, 16)} UTC</small>`
          + '<br><small>Thermal anomaly, not a burned-area polygon</small>',
          { direction: 'top' },
        )
        .addTo(group)
    })

    // One dissolved boundary around the best-estimate detections, drawn after the
    // footprints so it reads above them. Holes stay open: ground enclosed by
    // detections but never detected itself is not filled in.
    if (fireOutlineRings.length) {
      L.polygon(fireOutlineRings, {
        color: '#ff2f26',
        weight: 2.4,
        opacity: 0.95,
        fill: false,
        interactive: false,
        className: 'fire-outline',
      }).addTo(group)
    }

    if (layers.aircraft) {
      ;[...flights, ...importedTracks].forEach((flight) => {
        if (flight.observations?.length) {
          const visible = flight.observations.filter((observation) => observation.timestampMs <= frame.timestampMs)
          if (!visible.length) return

          plausibleObservationLinks(visible).forEach(({ previous, observation, impliedSpeedKt }) => {
            L.polyline([previous.position, observation.position], {
              color: flight.color,
              weight: 2.2,
              opacity: 0.78,
              dashArray: '5 6',
            })
              .bindTooltip(`<strong>${flight.callSign}: observed-fix connector</strong><br>${localObservationTime(previous.observedAt)}–${localObservationTime(observation.observedAt)} CEST · ${impliedSpeedKt.toFixed(0)} kt implied<br><small>Straight line between two MLAT fixes; the intervening route was not sampled.</small>`, { sticky: true })
              .addTo(group)
          })

          visible.forEach((observation) => {
            L.circleMarker(observation.position, {
              radius: 3.5,
              color: '#dcecff',
              weight: 1,
              fillColor: flight.color,
              fillOpacity: 0.58,
            })
              .bindTooltip(`<strong>${flight.callSign} observed</strong><br>${localObservationTime(observation.observedAt)} CEST · ${observation.altitudeFt ?? '—'} ft<br><small>${observation.updateType}; no position inferred between fixes</small>`, { direction: 'top' })
              .addTo(group)
          })

          const latest = visible.at(-1)
          const age = frame.timestampMs - latest.timestampMs
          if (age >= 0 && age <= OBSERVATION_RECENCY_MS) {
            L.marker(latest.position, { icon: aircraftIcon(flight), zIndexOffset: 900 })
              .bindTooltip(`<strong>${flight.callSign}: recent observation</strong><br>${localObservationTime(latest.observedAt)} CEST<br><small>This marker does not assert current airborne status.</small>`, { direction: 'top', offset: [0, -15] })
              .addTo(group)
          }
          return
        }

        if (!flight.points?.length) return
        L.polyline(flight.points, {
          color: flight.color,
          weight: 2,
          opacity: 0.72,
          dashArray: '4 5',
        })
          .bindTooltip(`<strong>${flight.callSign}</strong><br>${flight.label}<br><small>Static imported geometry; no timing inferred</small>`, { sticky: true })
          .addTo(group)
      })
    }

    if (layers.wind && frame.drossartWind) {
      const windIcon = windMapIcon({
        label: 'GRID',
        wind: frame.drossartWind,
        accent: '#72b7e6',
      })
      L.marker(frame.drossartWind.position, { icon: windIcon })
        .bindTooltip(windTooltip({
          name: 'Drossart model grid',
          wind: frame.drossartWind,
          source: 'Open-Meteo hourly model',
          status: 'not a station measurement',
        }), { direction: 'top', offset: [0, -18] })
        .addTo(group)
    }

    if (layers.rmiWind && frame.montRigiWind) {
      const windIcon = windMapIcon({
        label: 'RMI',
        wind: frame.montRigiWind,
        accent: '#8fd7c7',
      })
      L.marker(frame.montRigiWind.position, { icon: windIcon })
        .bindTooltip(windTooltip({
          name: 'Mont Rigi station 6494',
          wind: frame.montRigiWind,
          source: 'RMI ten-minute observation',
          status: 'awaiting RMI validation',
          distanceKm: 4.2,
        }), { direction: 'top', offset: [0, -18] })
        .addTo(group)
    }

    ;(frame.dwdWinds || []).forEach((wind) => {
      if (!layers[`dwdWind:${wind.id}`]) return
      const windIcon = windMapIcon({ label: 'DWD', wind, accent: '#b9a0e8' })
      L.marker(wind.position, { icon: windIcon })
        .bindTooltip(windTooltip({
          name: wind.name,
          wind,
          source: 'DWD ten-minute observation',
          status: 'preliminary recent/now feed',
          distanceKm: wind.distanceKm,
        }), { direction: 'top', offset: [0, -18] })
        .addTo(group)
    })
  }, [frameIndex, frame, flights, effisArea, effisCarriedForward, layers, importedTracks, firmsDetections, fireOutlineRings, protectedArea])

  return (
    <div className="map-surface" aria-label="Interactive fire situation map">
      <div className="map-fallback" aria-hidden="true">
        <span className="fallback-contour fallback-contour--one" />
        <span className="fallback-contour fallback-contour--two" />
        <span className="fallback-contour fallback-contour--three" />
      </div>
      <div ref={nodeRef} className="leaflet-host" />
    </div>
  )
}
