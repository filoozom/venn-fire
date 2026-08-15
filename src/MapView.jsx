import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  AIRCRAFT_PATH_MAX_GAP_MS,
  AIRCRAFT_PATH_MAX_SPEED_KT,
  effisBurnedArea,
  fireFrames,
  flights,
  incidentCenter,
  mapLabels,
  protectedArea,
} from './data'

const OBSERVATION_RECENCY_MS = 5 * 60 * 1000
const TRAFFIC_PATH_MAX_GAP_MS = 90 * 1000
const LOW_LEVEL_TRAFFIC_MAX_SPEED_KT = 250
const OVERFLIGHT_TRAFFIC_MAX_SPEED_KT = 700
const INCIDENT_MAP_BOUNDS = [[50.505, 6.015], [50.58, 6.135]]
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

function plausibleObservationSegments(observations, maxGapMs, maxSpeedKt) {
  const segments = []
  let current = []
  observations.forEach((observation) => {
    const previous = current.at(-1)
    if (!previous) {
      current = [observation]
      return
    }
    const elapsedMs = observation.timestampMs - previous.timestampMs
    const impliedSpeedKt = elapsedMs > 0
      ? haversineKm(previous, observation) / 1.852 / (elapsedMs / 3_600_000)
      : Number.POSITIVE_INFINITY
    if (elapsedMs > maxGapMs || impliedSpeedKt > maxSpeedKt) {
      if (current.length >= 2) segments.push(current)
      current = [observation]
      return
    }
    current.push(observation)
  })
  if (current.length >= 2) segments.push(current)
  return segments
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

function photoEvidenceIcon(flight) {
  return L.divIcon({
    className: 'photo-evidence-marker',
    html: `<span style="--flight-color:${flight.color}"><b>${flight.callSign}</b><small>LANDED PHOTO</small></span>`,
    iconSize: [94, 38],
    iconAnchor: [47, 19],
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

function trafficObservationIcon(flight) {
  const label = escapeHtml(flight.callSign || flight.registration || flight.icao24)
  return L.divIcon({
    className: `traffic-observation-marker traffic-observation-marker--${flight.classification}`,
    html: `<span style="--traffic-color:${flight.color}"><i></i><b>${label}</b></span>`,
    iconSize: [82, 24],
    iconAnchor: [7, 12],
  })
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
  layers,
  baseMode,
  onMapReady,
  importedTracks = [],
  connectedHotspots = [],
  nearbyTraffic = [],
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
      fire: () => map.flyToBounds(L.latLngBounds(effisBurnedArea.rings[0]), {
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

  }, [])

  useEffect(() => {
    const group = overlayRef.current
    if (!group) return
    group.clearLayers()

    const frame = fireFrames[frameIndex]

    L.circleMarker(incidentCenter, {
      radius: 7,
      color: '#fff3d6',
      weight: 2,
      fillColor: '#ef4f2f',
      fillOpacity: 0.9,
    })
      .bindTooltip('<strong>Drossart</strong><br><small>Reported fire locality · not an ignition-point survey</small>', { direction: 'top' })
      .addTo(group)

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

    if (layers.perimeter) {
      L.polygon(effisBurnedArea.rings, {
        className: 'fire-perimeter-glow',
        color: '#ff703e',
        fillColor: '#ef4f2f',
        weight: 8,
        opacity: 0.16,
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(group)

      L.polygon(effisBurnedArea.rings, {
        className: 'fire-perimeter-line',
        color: '#ff9a5a',
        fillColor: '#f04f2c',
        weight: 2.4,
        opacity: 0.96,
        fillOpacity: 0.22,
        dashArray: '8 5',
      })
        .bindPopup(`<div class="map-popup"><span class="eyebrow">COPERNICUS EFFIS · VIIRS NRT</span><strong>~${Math.round(effisBurnedArea.areaHa)} ha footprint geometry</strong><small>${effisBurnedArea.productLabel} · ${effisBurnedArea.nominalResolutionM} m sensor pixels</small><small>Automatically derived from active-fire detections; not field-confirmed and not synchronized to the five-minute slider.</small><small>Separate local reporting estimated ~100 ha affected by 20:32 CEST.</small></div>`)
        .bindTooltip(`<strong>EFFIS VIIRS-derived footprint</strong><br>~${Math.round(effisBurnedArea.areaHa)} ha geometry · ${effisBurnedArea.productLabel}<br><small>Static daily product, not a surveyed perimeter</small>`, { sticky: true })
        .addTo(group)

      const labelIcon = L.divIcon({
        className: 'fire-area-marker',
        html: `<div><span>EFFIS · VIIRS FOOTPRINT</span><strong>~${Math.round(effisBurnedArea.areaHa)} ha</strong><small>14 AUG DAILY · NOT SLIDER-TIMED</small></div>`,
        iconSize: [174, 66],
        iconAnchor: [87, 76],
      })
      L.marker(effisBurnedArea.labelPosition, { icon: labelIcon, interactive: false }).addTo(group)
    }

    if (layers.hotspots) {
      connectedHotspots.filter((spot) => spot.frame <= frameIndex).forEach((spot) => {
        const age = frameIndex - spot.frame
        const radius = spot.confidence === 'high' ? 7 : 5.5
        L.circleMarker(spot.position, {
          className: age <= 1 ? 'hotspot-pulse' : '',
          radius,
          color: age <= 2 ? '#fff3d6' : '#ffd2a6',
          weight: 1.2,
          fillColor: age <= 2 ? '#ff3d20' : '#db694d',
          fillOpacity: Math.max(0.34, 0.94 - age * 0.10),
        })
          .bindTooltip(`<strong>${spot.sensor} detection</strong><br>${spot.confidence} confidence · ${spot.frp ?? '—'} MW FRP<br><small>NASA FIRMS · ${spot.acquired}</small>`, { direction: 'top' })
          .addTo(group)
      })
    }

    if (layers.traffic) {
      nearbyTraffic.forEach((flight) => {
        const visible = flight.observations.filter((observation) => observation.timestampMs <= frame.timestampMs)
        if (!visible.length) return
        const lowLevel = flight.classification === 'low-level'
        const maxSpeedKt = lowLevel ? LOW_LEVEL_TRAFFIC_MAX_SPEED_KT : OVERFLIGHT_TRAFFIC_MAX_SPEED_KT
        const identifier = escapeHtml(flight.callSign || flight.registration || flight.icao24)
        const sourceName = escapeHtml(flight.source)
        const corroboration = flight.observedBy.length > 1
          ? `${flight.observedBy.length}-provider replay cross-check`
          : 'single retained replay source'

        plausibleObservationSegments(visible, TRAFFIC_PATH_MAX_GAP_MS, maxSpeedKt)
          .forEach((segment) => {
            const first = segment[0]
            const last = segment.at(-1)
            const altitudes = segment.map((observation) => observation.altitudeFt).filter(Number.isFinite)
            const altitudeRange = altitudes.length
              ? `${Math.min(...altitudes)}–${Math.max(...altitudes)} ft`
              : 'altitude unavailable'
            L.polyline(segment.map((observation) => observation.position), {
              color: flight.color,
              weight: lowLevel ? 1.7 : 1,
              opacity: lowLevel ? 0.68 : 0.34,
              dashArray: lowLevel ? '4 4' : '2 5',
              interactive: true,
            })
              .bindTooltip(`<strong>${identifier}: receiver-observed path segment</strong><br>${localObservationTime(first.observedAt)}–${localObservationTime(last.observedAt)} CEST · ${segment.length} exact samples · ${altitudeRange}<br><small>${sourceName}; adjacent samples joined only across ≤90 s and plausible speed · no incident role inferred</small>`, { sticky: true })
              .addTo(group)
          })

        visible.filter((observation) => observation.distanceDrossartKm <= 5).forEach((observation) => {
          L.circleMarker(observation.position, {
            radius: lowLevel ? 2.7 : 1.7,
            color: lowLevel ? '#fff4dd' : '#e5edf1',
            weight: lowLevel ? 0.9 : 0.5,
            fillColor: flight.color,
            fillOpacity: lowLevel ? 0.72 : 0.40,
          })
            .bindTooltip(`<strong>${identifier}: nearby traffic observation</strong><br>${localObservationTime(observation.observedAt)} CEST · ${observation.altitudeFt ?? '—'} ft · ${observation.distanceDrossartKm.toFixed(1)} km from Drossart<br><small>${sourceName} replay sample · ${corroboration} · no incident role inferred</small>`, { direction: 'top' })
            .addTo(group)
        })

        const latest = visible.at(-1)
        const age = frame.timestampMs - latest.timestampMs
        if (age >= 0 && age <= OBSERVATION_RECENCY_MS) {
          L.marker(latest.position, {
            icon: trafficObservationIcon(flight),
            zIndexOffset: lowLevel ? 520 : 360,
          })
            .bindTooltip(`<strong>${identifier}: recently observed traffic</strong><br>${localObservationTime(latest.observedAt)} CEST · ${latest.altitudeFt ?? '—'} ft<br><small>Observation within the preceding five minutes; current position or airborne status is not asserted.</small>`, { direction: 'top', offset: [0, -10] })
            .addTo(group)
        }
      })
    }

    if (layers.aircraft) {
      ;[...flights, ...importedTracks].forEach((flight) => {
        const visibleEvidence = (flight.evidenceObservations || [])
          .filter((evidence) => evidence.timestampMs <= frame.timestampMs)

        visibleEvidence.filter((evidence) => evidence.cameraPosition).forEach((evidence) => {
          L.marker(evidence.cameraPosition, { icon: photoEvidenceIcon(flight), zIndexOffset: 700 })
            .bindTooltip(`<strong>${evidence.label}</strong><br>${localObservationTime(evidence.observedAt)} CEST<br><small>Marker is the photograph's camera GPS position, not an aircraft track fix.</small>`, { direction: 'top', offset: [0, -16] })
            .addTo(group)
        })

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

    if (layers.wind) {
      const windIcon = L.divIcon({
        className: 'wind-map-card',
        html: `<div><span class="wind-compass"><svg viewBox="0 0 24 24" style="--wind-rotation:${(frame.windDirection + 180) % 360}deg" aria-hidden="true"><path d="M12 20V4M6.5 9.5 12 4l5.5 5.5"/></svg></span><p><b>from ${windCardinal(frame.windDirection)}</b><strong>${frame.windSpeed.toFixed(1)} km/h</strong><small>arrow toward ${windCardinal((frame.windDirection + 180) % 360)} · gust ${frame.gust.toFixed(1)}</small></p></div>`,
        iconSize: [148, 60],
        iconAnchor: [74, 30],
      })
      L.marker([50.575, 6.105], { icon: windIcon, interactive: false }).addTo(group)
    }
  }, [frameIndex, layers, importedTracks, connectedHotspots, nearbyTraffic])

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
