import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  aircraftTraceOpacity,
  fadingObservationPaths,
  visibleAircraftObservations,
} from './aircraftTracks'
import { firmsDetectionOpacityAt } from './firmsDetections'

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
  const normalized = normalizeDegrees(deg)
  return normalized == null ? '—' : names[Math.round(normalized / 22.5) % 16]
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

function formatMapDistance(metres) {
  if (!Number.isFinite(metres) || metres <= 0) return '0 m'
  return metres < 1_000
    ? `${Math.round(metres).toLocaleString('en-GB')} m`
    : `${(metres / 1_000).toLocaleString('en-GB', { maximumFractionDigits: metres < 10_000 ? 2 : 1 })} km`
}

function windMapIcon({ label, wind, accent }) {
  return L.divIcon({
    className: 'wind-source-marker',
    html: `<span style="--wind-accent:${accent}"><svg viewBox="0 0 24 24" style="--wind-rotation:${normalizeDegrees(Number(wind.windDirection) + 180) ?? 0}deg" aria-hidden="true"><path d="M12 20V4M6.5 9.5 12 4l5.5 5.5"/></svg><b>${label}</b></span>`,
    iconSize: [42, 42],
    iconAnchor: [21, 21],
  })
}

function windTooltip({ name, wind, source, status, distanceKm = 0 }) {
  const gust = Number.isFinite(wind.gust) ? ` · gust ${formatDecimal(wind.gust)} km/h` : ''
  return `<strong>${escapeHtml(name)}</strong><br>`
    + `Wind from ${windCardinal(wind.windDirection)} (${formatDegrees(wind.windDirection)}), blowing toward ${windCardinal(Number(wind.windDirection) + 180)} (${formatDegrees(Number(wind.windDirection) + 180)})<br>`
    + `${formatDecimal(wind.windSpeed)} km/h${gust} · ${wind.ageMinutes} min old<br>`
    + `<small>${escapeHtml(source)}${distanceKm ? ` · ${formatDecimal(distanceKm)} km from Drossart` : ''}${status ? ` · ${escapeHtml(status)}` : ''}</small>`
}

function aircraftIcon(flight, heading = 0) {
  const planePath = '<path d="M12 2l2 7 7 3v2l-7-1.5V18l2 2v1l-4-1-4 1v-1l2-2v-5.5L3 14v-2l7-3 2-7z" fill="currentColor"/>'
  const helicopterPath = '<path d="M3 7.5h18M12 7.5V5m-1-1h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M8.5 9h7.4c1.7 0 3.1 1.3 3.1 3v.5H8.5a3.5 3.5 0 010-7h2v3.5z" fill="currentColor"/><path d="M8 13.5l-2 3m9-3 2 3M4.5 17h13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
  return L.divIcon({
    className: 'aircraft-map-marker',
    html: `<span style="--flight-color:${flight.color};--aircraft-rotation:${heading}deg"><svg viewBox="0 0 24 24" aria-hidden="true">${flight.type === 'plane' ? planePath : helicopterPath}</svg></span><b>${escapeHtml(flight.callSign)}</b>`,
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
  rasterOverlays = [],
  measureMode = false,
  onMeasurementChange,
  sentinelBurnGeometry = null,
  sentinel3Detections = [],
  fireOutlineRings = [],
  mapLabels = [],
  protectedArea = [],
}) {
  const nodeRef = useRef(null)
  const mapRef = useRef(null)
  const tileRef = useRef(null)
  const overlayRef = useRef(null)
  const labelsRef = useRef(null)
  const measurementLayerRef = useRef(null)
  const measurementPointsRef = useRef([])
  const measurementCallbackRef = useRef(onMeasurementChange)

  useEffect(() => {
    measurementCallbackRef.current = onMeasurementChange
  }, [onMeasurementChange])

  useEffect(() => {
    if (!nodeRef.current || mapRef.current) return undefined

    const map = L.map(nodeRef.current, {
      zoomControl: false,
      attributionControl: true,
      // Route-fit controls may need a regional view (for example G17's
      // receiver-supported leg toward Brussels); Home still returns to the
      // incident extent.
      minZoom: 7,
      maxZoom: 18,
      zoomSnap: 0.25,
      preferCanvas: true,
    })
    map.fitBounds(INCIDENT_MAP_BOUNDS, INCIDENT_MAP_PADDING)
    mapRef.current = map
    overlayRef.current = L.layerGroup().addTo(map)
    labelsRef.current = L.layerGroup().addTo(map)
    measurementLayerRef.current = L.layerGroup().addTo(map)

    const tile = L.tileLayer(basemaps[baseMode].url, basemaps[baseMode].options).addTo(map)
    tileRef.current = tile

    const home = () => map.fitBounds(INCIDENT_MAP_BOUNDS, INCIDENT_MAP_PADDING)
    const fitPositions = (positions = [], options = {}) => {
      const valid = positions.filter((position) => (
        Array.isArray(position)
        && Number.isFinite(Number(position[0]))
        && Number.isFinite(Number(position[1]))
      ))
      if (!valid.length) return
      if (valid.length === 1) {
        map.flyTo(valid[0], 13, { duration: 0.8 })
        return
      }
      map.flyToBounds(L.latLngBounds(valid), {
        paddingTopLeft: options.paddingTopLeft ?? [35, 95],
        paddingBottomRight: options.paddingBottomRight ?? [35, 185],
        maxZoom: options.maxZoom ?? 14,
        duration: 0.8,
      })
    }
    const clearMeasurement = () => {
      measurementPointsRef.current = []
      measurementLayerRef.current?.clearLayers()
      measurementCallbackRef.current?.({ pointCount: 0, totalMetres: 0 })
    }
    onMapReady?.({
      zoomIn: () => map.zoomIn(0.75),
      zoomOut: () => map.zoomOut(0.75),
      home,
      fitPositions,
      clearMeasurement,
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
    if (!map) return undefined
    const container = map.getContainer()
    container.classList.toggle('is-measuring', measureMode)
    if (!measureMode) return () => container.classList.remove('is-measuring')

    const addMeasurementPoint = (event) => {
      if (event.target.closest?.('.leaflet-control, .leaflet-popup')) return
      const latlng = map.mouseEventToLatLng(event)
      const group = measurementLayerRef.current
      if (!group) return
      const previous = measurementPointsRef.current.at(-1)
      const segmentMetres = previous ? map.distance(previous.latlng, latlng) : 0
      const totalMetres = (previous?.totalMetres ?? 0) + segmentMetres
      const point = { latlng, totalMetres }
      measurementPointsRef.current.push(point)

      if (previous) {
        L.polyline([previous.latlng, latlng], {
          className: 'measurement-line measurement-line--casing',
          color: '#ffffff',
          weight: 6,
          opacity: 0.92,
          interactive: false,
        }).addTo(group)
        L.polyline([previous.latlng, latlng], {
          className: 'measurement-line',
          color: '#146e72',
          weight: 3,
          opacity: 0.96,
          dashArray: '8 5',
          interactive: false,
        }).addTo(group)
      }

      const marker = L.circleMarker(latlng, {
        className: 'measurement-point',
        color: '#ffffff',
        weight: 2,
        fillColor: '#146e72',
        fillOpacity: 1,
        radius: 5,
        interactive: false,
      }).addTo(group)
      marker.bindTooltip(previous
        ? `${formatMapDistance(segmentMetres)} · total ${formatMapDistance(totalMetres)}`
        : 'Measurement start', {
        permanent: true,
        direction: 'top',
        className: 'measurement-tooltip',
        offset: [0, -6],
      })
      measurementCallbackRef.current?.({
        pointCount: measurementPointsRef.current.length,
        totalMetres,
      })
    }

    // Listen at the map container in the capture phase. Leaflet's canvas
    // renderer can consume a map-level click when a rendered polygon sits under
    // the pointer; measuring must still work over the fire outline itself.
    container.addEventListener('click', addMeasurementPoint, true)
    return () => {
      container.removeEventListener('click', addMeasurementPoint, true)
      container.classList.remove('is-measuring')
    }
  }, [measureMode])

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
      if (!Array.isArray(label.position) || label.position.length !== 2) return
      const language = document.documentElement.lang === 'de' ? 'de' : 'en'
      const name = label.names?.[language] || label.name
      if (!name) return
      const isWater = label.kind === 'water'
      const waterRole = language === 'de' ? 'Wasserreservoir' : 'Water reservoir'
      const icon = L.divIcon({
        className: `map-place-label map-place-label--${label.kind}`,
        html: isWater
          ? `<span class="map-place-label__water"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8C9.9 6.2 5.8 10.2 5.8 14.4a6.2 6.2 0 0 0 12.4 0C18.2 10.2 14.1 6.2 12 2.8Z"/></svg><i><small>${waterRole}</small><b>${escapeHtml(name)}</b></i></span>`
          : `<span>${escapeHtml(name)}</span>`,
        iconSize: isWater ? [190, 42] : undefined,
        iconAnchor: isWater ? [15, 21] : [0, 0],
      })
      const marker = L.marker(label.position, { icon, interactive: isWater }).addTo(group)
      if (isWater) {
        marker.bindTooltip(
          `<strong>${escapeHtml(name)}</strong><br><small>${language === 'de' ? 'Nahegelegener Stausee als Flugrouten-Kontext; keine bestätigte Wasseraufnahme.' : 'Nearby reservoir shown as flight-route context; no water pickup is confirmed.'}</small>`,
          { direction: 'top', offset: [0, -18] },
        )
      }
    })

  }, [mapLabels])

  useEffect(() => {
    const group = overlayRef.current
    if (!group) return
    group.clearLayers()

    // The Drossart marker was removed: it plotted the place name used in the
    // incident reports, not a fire measurement, and read as an ignition point.
    // The database incident center remains the measurement datum for distances.

    rasterOverlays.forEach((overlay) => {
      if (!overlay?.url || !Array.isArray(overlay.bounds)) return
      L.imageOverlay(overlay.url, overlay.bounds, {
        opacity: overlay.opacity ?? 0.58,
        interactive: false,
        className: `environmental-raster environmental-raster--${overlay.kind || 'source'}`,
        attribution: overlay.attribution || '',
      }).addTo(group)
    })

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
        .bindPopup(`<div class="map-popup"><span class="eyebrow">COPERNICUS EFFIS · VIIRS NRT</span><strong>${Math.round(effisArea.areaHa).toLocaleString('en-GB')} ha activity envelope</strong><small>${effisArea.productLabel}${effisCarriedForward ? ' · carried forward as last available product' : ''} · ${effisArea.nominalResolutionM} m nominal sensor pixels</small><small>This shape contains the day's fire activity but can also enclose unaffected ground between detections. It is not a burned-area estimate or a field-confirmed perimeter.</small><small>Separate reporting at this selected time: ${frame.reportedAreaText} ha (${frame.areaLabel}).</small><a href="${effisArea.sourceRequestUrl}" target="_blank" rel="noreferrer">Open source WFS GeoJSON</a><a href="https://forest-fire.emergency.copernicus.eu/apps/effis.csv/?c=629562.19,6608535.18&amp;z=8.544845581054688&amp;t=sentinel2" target="_blank" rel="noreferrer">Open EFFIS viewer</a></div>`)
        .bindTooltip(`<strong>EFFIS daily activity envelope</strong><br>${Math.round(effisArea.areaHa).toLocaleString('en-GB')} ha calculated polygon area · ${effisArea.productLabel}<br><small>May include unaffected ground between detections</small>`, { sticky: true })
        .addTo(group)

    }

    // Sensor pixels shaded by confidence. Polar footprints use FIRMS' published
    // dimensions; Meteosat rectangles are labelled viewing-geometry
    // approximations because GOES_NRT does not publish physical dimensions.
    firmsDetections.forEach((detection) => {
      const style = FIRMS_CONFIDENCE_STYLE[detection.confidence.label] ?? FIRMS_CONFIDENCE_STYLE.unknown
      const recencyOpacity = firmsDetectionOpacityAt(detection, frame.timestampMs)
      const computedGeostationary = detection.footprintSource === 'computed-geostationary'
      const historicalFillOpacity = style.fillOpacity * recencyOpacity
      const fillOpacity = computedGeostationary ? Math.min(0.035, historicalFillOpacity) : historicalFillOpacity
      const layer = detection.displayMode === 'centroid'
        ? L.circleMarker(detection.position, {
            className: `firms-detection firms-detection--${detection.sensorKey} firms-detection--centroid`,
            color: style.color,
            weight: style.weight + 0.5,
            opacity: style.opacity * recencyOpacity,
            fillColor: style.color,
            fillOpacity,
            radius: 4 + Math.max(0, detection.confidence.rank ?? 0),
          })
        : L.polygon(detection.footprint, {
            className: `firms-detection firms-detection--${detection.sensorKey}${computedGeostationary ? ' firms-detection--computed' : ''}`,
            color: style.color,
            weight: style.weight,
            opacity: style.opacity * recencyOpacity,
            fillColor: style.color,
            fillOpacity,
            dashArray: computedGeostationary ? '6 5' : null,
          })
      const pixelDetail = computedGeostationary
        ? `${detection.scanKm.toFixed(1)} × ${detection.trackKm.toFixed(1)} km computed footprint (~${Math.round(detection.scanKm * detection.trackKm * 100).toLocaleString('en-GB')} ha pixel coverage; not fire area)`
        : detection.providesArea
          ? `${Math.round(detection.scanKm * detection.trackKm * 100)} ha sensor pixel`
          : `${detection.pixelSizeLabel} · detections only, no area derived`
      const footprintDetail = detection.displayMode === 'centroid'
        ? 'Exact detection centroid; no defensible footprint geometry available'
        : computedGeostationary
          ? `Approximate projection from native sampling and ${Number.isFinite(Number(detection.subSatelliteLongitude)) ? formatDegrees(detection.subSatelliteLongitude) : 'unknown'} service longitude; FIRMS publishes no pixel polygon`
          : 'Thermal anomaly, not a burned-area polygon'
      const retentionDetail = detection.sensorKey === 'meteosat'
        ? 'Instantaneous scan opacity fades to zero over 15 minutes'
        : 'Retained as timestamped polar-satellite evidence'
      layer.bindTooltip(
        `<strong>${detection.confidence.label} confidence</strong><br>`
        + `${detection.sensorName}${detection.satellite ? ` · ${detection.satellite}` : ''} · ${formatDecimal(detection.frpMw)} MW FRP<br>`
        + pixelDetail
        + `${detection.corroboratingSensors > 1 ? `<br>${detection.corroboratingSensors} satellites saw this cell` : ''}`
        + `<br><small>NASA FIRMS · ${detection.acquiredAt.replace('T', ' ').slice(0, 16)} UTC</small>`
        + `<br><small>${footprintDetail}. ${retentionDetail}.</small>`,
        { direction: 'top' },
      ).addTo(group)
    })

    sentinel3Detections.forEach((detection) => {
      const latitude = Number(detection.latitude)
      const longitude = Number(detection.longitude)
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return
      L.circleMarker([latitude, longitude], {
        className: 'sentinel3-frp-detection',
        color: '#9f2f73',
        fillColor: '#e04c9a',
        weight: 1.2,
        opacity: 0.9,
        fillOpacity: 0.3,
        radius: 5,
      }).bindTooltip(
        `<strong>Sentinel-3 SLSTR FRP detection</strong><br>`
        + `${formatDecimal(detection.frpMw)} MW${detection.channel ? ` · ${escapeHtml(detection.channel)}` : ''}<br>`
        + `<small>${escapeHtml(String(detection.acquiredAt || '').replace('T', ' ').slice(0, 16))} UTC · ${formatDecimal(detection.nominalResolutionM, 0)} m nominal product resolution</small>`,
        { direction: 'top' },
      ).addTo(group)
    })

    if (sentinelBurnGeometry?.features?.length) {
      L.geoJSON(sentinelBurnGeometry, {
        style: {
          color: '#765093',
          weight: 1.15,
          opacity: 0.88,
          fillColor: '#8f6aab',
          fillOpacity: 0.22,
          className: 'sentinel-burn-change',
        },
        onEachFeature: (feature, layer) => {
          const properties = feature.properties ?? {}
          layer.bindTooltip(
            `<strong>Sentinel-2 observed change</strong><br>`
            + `${Number(properties.supportCellCount ?? 0).toLocaleString('en-GB')} supported 50 m cells · ${formatDecimal(properties.supportAreaHa)} ha grid coverage<br>`
            + `<small>Near-infrared comparison · acquired ${escapeHtml(String(properties.acquiredAt ?? '').replace('T', ' ').slice(0, 16))} UTC · ${Math.round(Number(properties.clearFraction ?? 0) * 100)}% of the crop cloud-clear</small><br>`
            + '<small>Spectral change consistent with fire and connected to the corroborated fire core. It is not a field-confirmed perimeter; obscured pixels remain unknown.</small>',
            { sticky: true },
          )
        },
      }).addTo(group)
    }

    // One dissolved boundary around the complete selected 50 m union. Any
    // qualifying newest-pass MODIS pixels and repeat-supported aircraft lobe
    // have already been folded into these rings; no second edge is rendered.
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
          const visible = visibleAircraftObservations(flight.observations, frame.timestampMs)
          if (!visible.length) return

          fadingObservationPaths(visible, frame.timestampMs).forEach((path) => {
            L.polyline(path.observations.map((observation) => observation.position), {
              color: flight.color,
              weight: 2.2,
              opacity: 0.78 * path.opacity,
              dashArray: '5 6',
            })
              .bindTooltip(`<strong>${flight.callSign}: provider-supported route</strong><br>${path.observations.length.toLocaleString('en-GB')} exact fixes · ${localObservationTime(path.observations[0].observedAt)}–${localObservationTime(path.observations.at(-1).observedAt)} CEST<br><small>The aircraft qualified by entering the incident area. Its complete available incident-connected session fades linearly and disappears after 24 hours. Gaps over 2 minutes and implausible links are omitted; no position is inferred between fixes.</small>`, { sticky: true })
              .addTo(group)
          })

          const latest = visible.at(-1)
          const age = frame.timestampMs - latest.timestampMs
          const fadeOpacity = aircraftTraceOpacity(latest.timestampMs, frame.timestampMs)
          const recencyLabel = age <= OBSERVATION_RECENCY_MS ? 'recent observation' : 'last observed position'
          L.marker(latest.position, {
            icon: aircraftIcon(flight, latest.trackDegrees || 0),
            opacity: fadeOpacity,
            zIndexOffset: 900,
          })
            .bindTooltip(`<strong>${flight.callSign}: ${recencyLabel}</strong><br>${localObservationTime(latest.observedAt)} CEST · ${latest.altitudeFt ?? '—'} ft<br><small>${escapeHtml(latest.updateType || 'Receiver observation')}; this marker does not assert current airborne status, and no position is inferred after this fix.</small>`, { direction: 'top', offset: [0, -15] })
            .addTo(group)
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
          status: 'preliminary',
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
  }, [frameIndex, frame, flights, effisArea, effisCarriedForward, layers, importedTracks, firmsDetections, rasterOverlays, sentinelBurnGeometry, sentinel3Detections, fireOutlineRings, protectedArea])

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
