import { camsForecastFrameAt } from './camsForecasts.js'
import { effisAreaForTimestamp, FIVE_MINUTES_MS } from './data.js'
import { visibleAircraftObservations } from './aircraftTracks.js'
import { AIRCRAFT_EDGE_GRID_CELL_M, AIRCRAFT_EDGE_TIME_BUCKET_MS, deriveAircraftSupportedEdge } from './aircraftFireEstimate.js'
import { BURNED_AREA_RETENTION_MS, deriveFireActivityAreas } from './fireActivityEstimate.js'
import { FIRMS_SENSORS, corroborateDetections, detectionFootprint, footprintOutlineRings } from './firmsDetections.js'
import { MODIS_EXTENT_GRID_CELL_M, MODIS_EXTENT_TIME_BUCKET_MS, deriveRetainedModisSupportedExtent } from './modisFireEstimate.js'
import { SOURCE_FADE_WINDOWS_MS, effisGeometryOpacityAt, linearSourceOpacity } from './sourceFreshness.js'

export function footprintOriginFor(runtime) {
  const reference = runtime.firms.locationReference
  if (Number.isFinite(reference?.latitude) && Number.isFinite(reference?.longitude)) return reference
  const [latitude, longitude] = runtime.incidentCenter
  return { latitude: Number(latitude), longitude: Number(longitude) }
}

export function firmsDetectionsForMap(detections, timelineStartMs) {
  const decimal = (value) => value == null || value === '' || !Number.isFinite(Number(value))
    ? '—' : Number(value).toLocaleString('en-GB', { maximumFractionDigits: 1 })
  return detections.map((detection) => {
    const sensor = FIRMS_SENSORS.find((entry) => entry.key === detection.sensorKey)
    const timestampMs = Date.parse(detection.acquiredAt)
    return {
      ...detection,
      sensorName: sensor?.name ?? detection.sensorKey,
      sensorColor: sensor?.color ?? '#efaa3c',
      providesArea: sensor?.providesArea === true,
      displayMode: detection.displayMode ?? sensor?.displayMode ?? 'footprint',
      pixelSizeLabel: sensor?.pixelSizeLabel ?? detection.pixelSizeLabel ?? `${decimal(detection.scanKm)} × ${decimal(detection.trackKm)} km pixel`,
      areaExclusionReason: sensor?.areaExclusionReason ?? detection.areaExclusionReason ?? null,
      footprint: detection.footprint ?? detectionFootprint(detection),
      position: [detection.latitude, detection.longitude],
      timestampMs,
      frame: Math.max(0, Math.ceil((timestampMs - timelineStartMs) / FIVE_MINUTES_MS)),
    }
  })
}

function sourceRecordWithOpacity(record, observedAt, timestampMs, lifetimeMs) {
  return record ? {
    ...record,
    displayObservedAt: observedAt,
    displayOpacity: linearSourceOpacity(observedAt, timestampMs, lifetimeMs),
  } : null
}

export function environmentalStateAt(runtime, timestampMs) {
  const selectedEffisArea = effisAreaForTimestamp(runtime.effisProducts, timestampMs)
  const currentEffisArea = selectedEffisArea ? {
    ...selectedEffisArea,
    displayOpacity: effisGeometryOpacityAt(selectedEffisArea, timestampMs),
  } : null
  const visibleSentinelAnalyses = (runtime.sentinel2.analyses ?? [])
    .filter((analysis) => analysis.status === 'ready' && Date.parse(analysis.acquiredAt) <= timestampMs)
    .map((analysis) => sourceRecordWithOpacity(analysis, analysis.acquiredAt, timestampMs, SOURCE_FADE_WINDOWS_MS.sentinel2Change))
  const radar = (runtime.rmiRadar.frames ?? []).findLast((row) => Date.parse(row.observedAt) <= timestampMs)
  const dailyImage = (layerKey) => {
    const date = new Date(timestampMs).toISOString().slice(0, 10)
    const record = (runtime.nasaGibs.images ?? []).findLast((row) => row.layerKey === layerKey && row.date <= date)
    return sourceRecordWithOpacity(record, `${record?.date}T00:00:00.000Z`, timestampMs, SOURCE_FADE_WINDOWS_MS.dailyImagery)
  }
  const forecast = (productKey) => {
    const record = camsForecastFrameAt(runtime.cams.frames, productKey, timestampMs)
    return sourceRecordWithOpacity(record, record?.validAt, timestampMs, SOURCE_FADE_WINDOWS_MS.camsForecast)
  }
  const visibleSentinel3Detections = (runtime.sentinel3Frp.detections ?? [])
    .map((row) => sourceRecordWithOpacity(row, row.acquiredAt, timestampMs, SOURCE_FADE_WINDOWS_MS.sentinel3Frp))
    .filter((row) => row.displayOpacity > 0)
  return {
    currentEffisArea,
    visibleSentinelAnalyses,
    currentSentinelAnalysis: visibleSentinelAnalyses.at(-1) ?? null,
    currentRmiRadar: sourceRecordWithOpacity(radar, radar?.observedAt, timestampMs, SOURCE_FADE_WINDOWS_MS.precipitationRadar),
    currentGibsFalseColor: dailyImage('false-color'),
    currentGibsTrueColor: dailyImage('true-color'),
    currentCamsWildfirePm10: forecast('wildfire-pm10'),
    currentCamsPm2p5: forecast('pm2p5'),
    visibleSentinel3Detections,
    sentinelBurnGeometry: {
      type: 'FeatureCollection',
      features: visibleSentinelAnalyses
        .filter((analysis) => analysis.displayOpacity > 0 && analysis.geometry?.coordinates?.length)
        .map((analysis) => ({
          type: 'Feature',
          properties: {
            acquiredAt: analysis.acquiredAt,
            supportCellCount: analysis.supportCellCount,
            supportAreaHa: analysis.supportAreaHa,
            clearFraction: analysis.clearFraction,
            preSceneId: analysis.preScene?.id,
            postSceneId: analysis.postScene?.id,
            displayOpacity: analysis.displayOpacity,
          },
          geometry: analysis.geometry,
        })),
    },
  }
}

export function rasterOverlaysAt(runtime, state) {
  const definitions = [
    ['gibsFalseColor', 'gibs-false-color', state.currentGibsFalseColor, runtime.nasaGibs.bounds, 0.72, 'NASA EOSDIS GIBS', 'nasa-gibs'],
    ['gibsTrueColor', 'gibs-true-color', state.currentGibsTrueColor, runtime.nasaGibs.bounds, 0.72, 'NASA EOSDIS GIBS', 'nasa-gibs'],
    ['camsWildfirePm10', 'cams-wildfire-pm10', state.currentCamsWildfirePm10, runtime.cams.bounds, 0.44, runtime.cams.attribution, 'cams'],
    ['camsPm2p5', 'cams-pm2p5', state.currentCamsPm2p5, runtime.cams.bounds, 0.42, runtime.cams.attribution, 'cams'],
    ['rmiRadar', 'rmi-radar', state.currentRmiRadar, runtime.rmiRadar.bounds, 0.74, 'Royal Meteorological Institute of Belgium', state.currentRmiRadar?.providerKey === 'dwd-radolan-yw' ? 'dwd-radar-history' : 'rmi-radar'],
  ]
  return definitions.flatMap(([key, kind, record, bounds, opacity, attribution, sourceKey]) => (
    record?.displayOpacity > 0 && record.image?.databaseUrl ? [{
      key, kind, sourceKey,
      id: `${kind}-${record.image.artifactKey ?? record.image.databaseUrl}`,
      url: record.image.databaseUrl,
      image: record.image,
      bounds: record.bounds ?? bounds,
      opacity: opacity * record.displayOpacity,
      attribution: record.attribution ?? attribution,
      // The RMI animation is already Mercator; the other retained crops use lon/lat pixels.
      crs: sourceKey === 'rmi-radar' ? 'EPSG:3857' : 'EPSG:4326',
    }] : []
  ))
}

export function bestEstimateAt({ detections, sentinelAnalyses, flights, timestampMs, origin }) {
  const bestEstimateCoreDetections = corroborateDetections(detections.filter((detection) => (
    timestampMs - detection.timestampMs >= 0 && timestampMs - detection.timestampMs < BURNED_AREA_RETENTION_MS
  ))).filter((detection) => detection.isFireCore)
  const modisOptions = {
    detections,
    coreDetections: bestEstimateCoreDetections,
    frameTimestampMs: timestampMs,
    minimumTimestampMs: timestampMs - BURNED_AREA_RETENTION_MS,
    origin,
    gridCellM: MODIS_EXTENT_GRID_CELL_M,
    timeBucketMs: MODIS_EXTENT_TIME_BUCKET_MS,
  }
  // Seed aircraft selection with VIIRS and at most one supported MODIS pass.
  const seed = deriveRetainedModisSupportedExtent({ ...modisOptions, aircraftEdgeCandidates: [] })
  const referenceDetections = [...bestEstimateCoreDetections, ...seed.detections]
  const aircraftSupportedEdge = deriveAircraftSupportedEdge({
    flights: flights.map((flight) => ({
      ...flight,
      observations: visibleAircraftObservations(flight.observations, timestampMs, BURNED_AREA_RETENTION_MS)
        .filter((observation) => observation.routeScope !== 'full-route'),
    })).filter((flight) => flight.observations.length),
    detections: referenceDetections,
    outlineRings: footprintOutlineRings(referenceDetections, { gridCellM: 50, origin }),
    frameTimestampMs: timestampMs,
    origin,
    gridCellM: AIRCRAFT_EDGE_GRID_CELL_M,
    timeBucketMs: AIRCRAFT_EDGE_TIME_BUCKET_MS,
  })
  const modisSupportedExtent = deriveRetainedModisSupportedExtent({ ...modisOptions, aircraftEdgeCandidates: aircraftSupportedEdge.candidates })
  const fireActivityAreas = deriveFireActivityAreas({
    thermalDetections: [...bestEstimateCoreDetections, ...modisSupportedExtent.detections],
    sentinelAnalyses,
    aircraftSupportFeatures: aircraftSupportedEdge.supportFeatures,
    frameTimestampMs: timestampMs,
    origin,
    gridCellM: 50,
  })
  return { bestEstimateCoreDetections, aircraftSupportedEdge, modisSupportedExtent, fireActivityAreas }
}
