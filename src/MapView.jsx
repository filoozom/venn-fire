import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  fireFrames,
  flights,
  hotspots,
  incidentCenter,
  mapLabels,
  protectedArea,
} from './data'

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

function segmentAt(points, progress) {
  if (progress <= 0) return { points: [points[0]], position: points[0] }
  if (progress >= 1) return { points, position: points[points.length - 1] }

  const scaled = progress * (points.length - 1)
  const index = Math.floor(scaled)
  const fraction = scaled - index
  const start = points[index]
  const end = points[index + 1]
  const position = [
    start[0] + (end[0] - start[0]) * fraction,
    start[1] + (end[1] - start[1]) * fraction,
  ]
  return { points: [...points.slice(0, index + 1), position], position }
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

function headingBetween(a, b) {
  const lat1 = a[0] * Math.PI / 180
  const lat2 = b[0] * Math.PI / 180
  const dLon = (b[1] - a[1]) * Math.PI / 180
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

export default function MapView({ frameIndex, layers, baseMode, onMapReady, importedTracks = [], connectedHotspots = [] }) {
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
    map.fitBounds([[50.548, 5.965], [50.664, 6.265]], { padding: [18, 18] })
    mapRef.current = map
    overlayRef.current = L.layerGroup().addTo(map)
    labelsRef.current = L.layerGroup().addTo(map)

    const tile = L.tileLayer(basemaps[baseMode].url, basemaps[baseMode].options).addTo(map)
    tileRef.current = tile

    const home = () => map.fitBounds([[50.548, 5.965], [50.664, 6.265]], { padding: [18, 18] })
    onMapReady?.({
      zoomIn: () => map.zoomIn(0.75),
      zoomOut: () => map.zoomOut(0.75),
      home,
      fire: () => map.flyTo(incidentCenter, 14, { duration: 0.8 }),
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

    const border = [
      [50.548, 6.222], [50.571, 6.224], [50.588, 6.219], [50.608, 6.222],
      [50.632, 6.215], [50.651, 6.201], [50.665, 6.194],
    ]
    L.polyline(border, { color: '#f6f0d8', weight: 2, opacity: 0.78, dashArray: '8 8', interactive: false }).addTo(group)
    const borderLabel = L.divIcon({ className: 'border-label', html: '<span>BELGIUM&nbsp;&nbsp;·&nbsp;&nbsp;GERMANY</span>' })
    L.marker([50.625, 6.218], { icon: borderLabel, interactive: false, rotationAngle: 0 }).addTo(group)
  }, [])

  useEffect(() => {
    const group = overlayRef.current
    if (!group) return
    group.clearLayers()

    const frame = fireFrames[frameIndex]

    if (layers.protected) {
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
      const historyStep = Math.max(1, Math.floor(frameIndex / 4))
      fireFrames.slice(0, frameIndex).forEach((historic, index) => {
        if (index % historyStep !== 0 || index === frameIndex - 1) return
        L.polygon(historic.perimeter, {
          color: '#f6a15a',
          weight: 1,
          fill: false,
          opacity: 0.18 + (index / Math.max(frameIndex, 1)) * 0.18,
          dashArray: '3 5',
          interactive: false,
        }).addTo(group)
      })

      L.polygon(frame.perimeter, {
        className: 'fire-perimeter-glow',
        color: '#ff703e',
        fillColor: '#ef4f2f',
        weight: 8,
        opacity: 0.16,
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(group)

      L.polygon(frame.perimeter, {
        className: 'fire-perimeter-line',
        color: '#ff9a5a',
        fillColor: '#f04f2c',
        weight: 2.4,
        opacity: 0.96,
        fillOpacity: 0.28,
      })
        .bindPopup(`<div class="map-popup"><span class="eyebrow">INCIDENT RECONSTRUCTION</span><strong>~${frame.reportedHa} hectares</strong><small>${frame.areaLabel} · ${frame.shortTime} CEST</small></div>`)
        .addTo(group)

      const labelIcon = L.divIcon({
        className: 'fire-area-marker',
        html: `<div><span>REPORTED AREA</span><strong>~${frame.reportedHa} ha</strong><small>${frame.shortTime} CEST</small></div>`,
        iconSize: [128, 64],
        iconAnchor: [-10, 22],
      })
      L.marker([50.5960, 6.1988], { icon: labelIcon, interactive: false }).addTo(group)
    }

    if (layers.hotspots) {
      const displayedHotspots = connectedHotspots.length ? connectedHotspots : hotspots
      displayedHotspots.filter((spot) => spot.frame <= frameIndex).forEach((spot) => {
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
          .bindTooltip(`<strong>${spot.sensor} detection</strong><br>${spot.confidence} confidence · ${spot.frp ?? '—'} MW FRP<br><small>${spot.connected ? `NASA FIRMS · ${spot.acquired}` : 'Reference reconstruction point'}</small>`, { direction: 'top' })
          .addTo(group)
      })
    }

    if (layers.aircraft) {
      ;[...flights, ...importedTracks].forEach((flight) => {
        if (frameIndex < flight.startFrame) return
        const progress = Math.min(1, Math.max(0.03, (frameIndex - flight.startFrame + 0.15) / Math.max(1, flight.endFrame - flight.startFrame)))
        const segment = segmentAt(flight.points, progress)
        const isInAir = frameIndex < flight.endFrame

        L.polyline(flight.points, {
          color: flight.color,
          weight: 1.5,
          opacity: 0.22,
          dashArray: '3 7',
          interactive: false,
        }).addTo(group)

        L.polyline(segment.points, {
          color: flight.color,
          weight: isInAir ? 2.5 : 1.8,
          opacity: isInAir ? 0.94 : 0.42,
          lineCap: 'round',
          dashArray: isInAir ? undefined : '4 5',
        })
          .bindTooltip(`<strong>${flight.callSign}</strong><br>${flight.label}<br><small>${flight.status}</small>`, { sticky: true })
          .addTo(group)

        const lastIndex = Math.min(flight.points.length - 2, Math.floor(progress * (flight.points.length - 1)))
        const heading = headingBetween(flight.points[lastIndex], flight.points[lastIndex + 1])
        if (isInAir) {
          L.marker(segment.position, { icon: aircraftIcon(flight, heading), zIndexOffset: 900 })
            .bindTooltip(`<strong>${flight.callSign}</strong><br>${flight.label}`, { direction: 'top', offset: [0, -15] })
            .addTo(group)
        }

        const visibleDrops = Math.floor((flight.drops || 0) * progress)
        for (let drop = 0; drop < visibleDrops; drop += 1) {
          const nearby = flight.points.filter((point) => Math.abs(point[0] - incidentCenter[0]) < 0.008 && Math.abs(point[1] - incidentCenter[1]) < 0.012)
          const point = nearby[drop % Math.max(nearby.length, 1)] || incidentCenter
          const dropIcon = L.divIcon({ className: 'water-drop-marker', html: '<span></span>', iconSize: [10, 14], iconAnchor: [5, 7] })
          L.marker([point[0] + drop * 0.00022, point[1] - drop * 0.00018], { icon: dropIcon, interactive: false }).addTo(group)
        }
      })
    }

    if (layers.wind) {
      const windPoints = [
        [50.569, 6.085], [50.575, 6.157], [50.575, 6.228],
        [50.607, 6.075], [50.612, 6.147], [50.614, 6.235],
        [50.642, 6.090], [50.647, 6.162], [50.648, 6.239],
      ]
      windPoints.forEach((position, index) => {
        const jitter = (index % 3 - 1) * 4
        const direction = (frame.windDirection + 180 + jitter) % 360
        const opacity = 0.48 + (index % 2) * 0.18
        const icon = L.divIcon({
          className: 'wind-map-arrow',
          html: `<svg viewBox="0 0 24 24" style="--wind-rotation:${direction}deg;--wind-opacity:${opacity}" aria-hidden="true"><path d="M12 20V4M6.5 9.5 12 4l5.5 5.5"/></svg>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        })
        L.marker(position, { icon, interactive: false }).addTo(group)
      })

      const windIcon = L.divIcon({
        className: 'wind-map-card',
        html: `<div><span class="wind-compass"><svg viewBox="0 0 24 24" style="--wind-rotation:${(frame.windDirection + 180) % 360}deg" aria-hidden="true"><path d="M12 20V4M6.5 9.5 12 4l5.5 5.5"/></svg></span><p><b>${windCardinal(frame.windDirection)}</b><strong>${frame.windSpeed.toFixed(1)} km/h</strong><small>gusts ${frame.gust.toFixed(1)}</small></p></div>`,
        iconSize: [148, 60],
        iconAnchor: [74, 30],
      })
      L.marker([50.5558, 6.022], { icon: windIcon, interactive: false }).addTo(group)
    }
  }, [frameIndex, layers, importedTracks, connectedHotspots])

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
