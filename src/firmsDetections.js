// NASA FIRMS active-fire detections.
//
// A detection is a thermal anomaly: the sensor reported that a pixel of a given
// size was radiating enough to trigger the fire-detection algorithm. It is not a
// burned-area polygon and not an official affected-area figure.
//
// This module also derives a hectare estimate from those detections. That number
// is a DERIVED ESTIMATE, never a measurement. Every value it produces carries the
// method string that generated it and the sensor that supplied the input, so the
// figure can never appear in the interface without its provenance. See
// FOOTPRINT_ESTIMATE_CAVEATS for the error directions it cannot correct for.

const FIRMS_API_ROOT = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv'
const FIRMS_KEY_URL = 'https://firms.modaps.eosdis.nasa.gov/api/map_key/'
const FIRMS_SOURCE_URL = 'https://firms.modaps.eosdis.nasa.gov/'

// FIRMS caps a single area request at 10 days for the polar products. The
// geostationary product rejects anything over 2, so the cap is per sensor.
const MAX_DAY_RANGE = 10

// Each sensor is a separate published product from a separate spacecraft, so
// each gets its own map layer and colour, and standalone sensor summaries stay
// separate. The Best estimate is the deliberate exception: other modules select
// only the newest nearby high-confidence MODIS pixels and any qualifying
// compact aircraft-bounded lobes before the caller unions them with its corroborated
// VIIRS core on one raster.
export const FIRMS_SENSORS = [
  {
    key: 'viirsSnpp',
    defaultVisible: true,
    providesArea: true,
    apiSource: 'VIIRS_SNPP_NRT',
    name: 'VIIRS Suomi-NPP',
    platform: 'Suomi NPP',
    instrument: 'VIIRS',
    nominalResolutionM: 375,
    color: '#efaa3c',
    tone: 'nasa',
    cadence: 'About 2 overpasses per day at this latitude',
    // NASA has announced that Suomi-NPP product delivery ends on 1 Nov 2026.
    retirementNote: 'Suomi-NPP delivery ends 1 November 2026; NOAA-20 and NOAA-21 continue.',
  },
  {
    key: 'viirsNoaa20',
    defaultVisible: true,
    providesArea: true,
    apiSource: 'VIIRS_NOAA20_NRT',
    name: 'VIIRS NOAA-20',
    platform: 'NOAA-20',
    instrument: 'VIIRS',
    nominalResolutionM: 375,
    color: '#e96838',
    tone: 'nasa',
    cadence: 'About 2 overpasses per day at this latitude',
    retirementNote: null,
  },
  {
    key: 'viirsNoaa21',
    defaultVisible: true,
    providesArea: true,
    apiSource: 'VIIRS_NOAA21_NRT',
    name: 'VIIRS NOAA-21',
    platform: 'NOAA-21',
    instrument: 'VIIRS',
    nominalResolutionM: 375,
    color: '#d1495b',
    tone: 'nasa',
    cadence: 'About 2 overpasses per day at this latitude',
    retirementNote: null,
  },
  {
    key: 'modis',
    defaultVisible: false,
    providesArea: false,
    displayMode: 'footprint',
    pixelSizeLabel: '1 km nominal pixel',
    areaExclusionReason: 'MODIS pixels are too coarse for a standalone per-sensor area. Only tightly filtered newest-pass pixels can extend the combined Best estimate.',
    apiSource: 'MODIS_NRT',
    name: 'MODIS Terra/Aqua',
    platform: 'Terra and Aqua',
    instrument: 'MODIS',
    nominalResolutionM: 1000,
    color: '#8d6e97',
    tone: 'nasa',
    cadence: 'Up to 4 overpasses per day at this latitude',
    retirementNote: 'MODIS pixels are 1 km nominal; footprint estimates are correspondingly coarser.',
  },
  {
    // FIRMS files the geostationary product under GOES_NRT, but over Europe it
    // returns Meteosat: Met12 is MTG-I1, Met9 and Met10 are the older MSG
    // spacecraft. It is the only source here that observes continuously rather
    // than at overpasses.
    key: 'meteosat',
    apiSource: 'GOES_NRT',
    // Off by default. A detection locates the fire only to within its pixel, and
    // that pixel is larger than the fire was for most of the incident.
    defaultVisible: false,
    // Drawn at its computed approximate extent, not as a point. A dot would imply a
    // precision this sensor does not have. The rectangle is an explicitly
    // approximate projection of the native pixel onto the incident area.
    displayMode: 'footprint',
    name: 'Meteosat (geostationary)',
    platform: 'Met12 / Met10 / Met9',
    instrument: 'GEO',
    // Nominal thermal-channel sampling at nadir. Ground sampling grows sharply
    // at this latitude, which is why this sensor never yields an area figure.
    nominalResolutionM: 3000,
    providesArea: false,
    // Computed from each spacecraft's native sampling, 14-15 August 2026 orbit
    // position and local viewing geometry. Met9 is over the Indian Ocean at
    // 45.5 E, so it is materially coarser here than the two 0-degree platforms.
    pixelSizeLabel: 'computed footprint: Met12 ~2.1 × 4.1 km; Met10 ~3.2 × 6.1 km; Met9 ~3.3 × 9.1 km',
    areaExclusionReason: 'A computed Meteosat ground pixel covers roughly 880-3,010 ha here, depending on the spacecraft. GOES_NRT does not publish physical pixel dimensions, so these are viewing-geometry approximations and are never used as fire-area figures.',
    // FIRMS rejects a longer window for this product.
    maxDayRange: 2,
    color: '#7f9bb5',
    tone: 'nasa',
    cadence: 'Met12 every 10 minutes; MSG platforms every 15 minutes',
    retirementNote: 'Ground pixels span roughly 2.1 x 4.1 km to 3.3 x 9.1 km here. Detections and FRP only; no area is derived from them.',
  },
]

// Corroboration: whether independent spacecraft saw the same patch of ground.
//
// A single overpass can trigger on something that is not an active fire front.
// The 15 August 00:35 NOAA-20 pass produced 27 detections west of the burn at a
// mean 2.5 MW, against 37.9 MW in the corroborated core, and not one of them was
// high confidence or seen by any other satellite. Requiring agreement between
// two spacecraft removes that fringe without touching any published value.
export const CORROBORATION_CELL_DEGREES = 0.005 // about 500 m at this latitude
export const CORROBORATION_MIN_SENSORS = 2

const INSTRUMENT_BY_SENSOR_KEY = new Map(FIRMS_SENSORS.map((sensor) => [sensor.key, sensor.instrument]))

/**
 * Tag each detection with how many distinct satellites observed its cell.
 *
 * Only VIIRS corroborates by default. A 1 km MODIS pixel covers far more ground
 * than a 375 m VIIRS pixel, so treating the two as agreeing on a location would
 * overstate what MODIS can actually resolve. MODIS detections are therefore
 * marked with a null count and are never part of the corroborated set.
 */
export function corroborateDetections(detections, options = {}) {
  const cellDegrees = options.cellDegrees ?? CORROBORATION_CELL_DEGREES
  const minSensors = options.minSensors ?? CORROBORATION_MIN_SENSORS
  const eligibleInstruments = new Set(options.eligibleInstruments ?? ['VIIRS'])

  const isEligible = (detection) => eligibleInstruments.has(INSTRUMENT_BY_SENSOR_KEY.get(detection.sensorKey))
  const cellKey = (detection) => `${Math.floor(detection.latitude / cellDegrees)}:${Math.floor(detection.longitude / cellDegrees)}`

  const sensorsByCell = new Map()
  const highConfidenceByCell = new Map()
  for (const detection of detections) {
    if (!isEligible(detection)) continue
    const key = cellKey(detection)
    if (!sensorsByCell.has(key)) sensorsByCell.set(key, new Set())
    sensorsByCell.get(key).add(detection.sensorKey)
    if (detection.confidence.label === 'high') {
      highConfidenceByCell.set(key, (highConfidenceByCell.get(key) ?? 0) + 1)
    }
  }

  return detections.map((detection) => {
    if (!isEligible(detection)) {
      return {
        ...detection,
        corroboratingSensors: null,
        isCorroborated: false,
        cellHighConfidenceCount: null,
        isFireCore: false,
      }
    }
    const key = cellKey(detection)
    const count = sensorsByCell.get(key)?.size ?? 0
    const highConfidenceCount = highConfidenceByCell.get(key) ?? 0
    const isCorroborated = count >= minSensors
    return {
      ...detection,
      corroboratingSensors: count,
      isCorroborated,
      cellHighConfidenceCount: highConfidenceCount,
      // The tightest extent: two spacecraft agree on the cell AND at least one
      // of them reported high confidence there. A neighbouring nominal-confidence
      // detection in the same cell is kept, because the cell is already anchored
      // by a high-confidence observation.
      isFireCore: isCorroborated && highConfidenceCount >= 1,
    }
  })
}

export const FOOTPRINT_ESTIMATE_CAVEATS = [
  'A detection marks a pixel that was radiating at the moment of the overpass. The published footprint is the whole sensor pixel, so a fire front far smaller than the pixel still marks the entire footprint. The estimate therefore overstates area for narrow or broken fire fronts.',
  'Only ground that was actively flaming during an overpass can be detected. Ground that ignited and burned out between overpasses is never counted, and smoke or cloud removes further detections. The estimate therefore understates area for a fast-moving fire between passes.',
  'Because those two errors act in opposite directions and do not cancel predictably, this figure is neither an upper nor a lower bound on burned area.',
  'The footprint rectangle is axis-aligned in latitude and longitude from the published scan and track pixel dimensions. It approximates the true sensor parallelogram and ignores the scan-angle rotation.',
  'Standalone sensor figures are estimated independently and must not be added. The Best estimate instead computes one geometric union of its selected VIIRS and newest-pass MODIS footprints plus any compact repeat-supported aircraft lobes, so overlapping ground is counted once.',
  'Corroboration records that two spacecraft observed the same cell. It raises confidence that something was burning there; it does not measure how much of the cell burned, and an uncorroborated detection is not thereby proven false.',
]

// Footprints from one scan line abut exactly, so the half-open cell test has to
// tolerate floating-point error on the shared edge. Without this, two touching
// pixels leave an empty one-cell seam between them: the area is understated and
// the outline is cut by spurious slits.
const CELL_EDGE_EPSILON_M = 1e-6

// Geostationary ground-pixel geometry.
//
// GOES_NRT does not publish physical pixel dimensions in scan/track (Met12 uses
// zeroes; MSG rows carry image-grid coordinates), so an approximate ground
// footprint has to be computed. It is not the nadir figure: the large viewing
// zenith angle stretches the pixel along the line of sight.
//
// The result is the single most important thing to show about this sensor. One
// MSG pixel covers around 1,970 ha from the 0-degree service and around 3,010 ha
// from Met9 at 45.5 E -- more than the whole fire was reported to be on the
// morning of 15 August. This is a local tangent-plane approximation, not a
// pixel polygon published by FIRMS or EUMETSAT.
const EARTH_RADIUS_KM = 6378.137
const GEOSTATIONARY_ALTITUDE_KM = 35786.0

// Nadir instantaneous field of view by spacecraft generation.
const GEOSTATIONARY_NADIR_KM = { mtg: 2, msg: 3 }

// Operational positions during this incident, sourced from EUMETSAT's service
// history. Met9 is the Indian Ocean service, Met10 is the secondary 0-degree
// full-disc service, Met11 is the 9.5 E rapid-scan MSG, and Met12 is MTG-I1.
// Meteosat-11 is MSG-4; treating every "Met11+" platform as MTG is incorrect.
const GEOSTATIONARY_PLATFORMS = new Map([
  ['met9', { generation: 'msg', subSatelliteLongitude: 45.5 }],
  ['met10', { generation: 'msg', subSatelliteLongitude: 0 }],
  ['met11', { generation: 'msg', subSatelliteLongitude: 9.5 }],
  ['met12', { generation: 'mtg', subSatelliteLongitude: 0 }],
])

function normalizedGeostationaryName(satellite) {
  return String(satellite ?? '').trim().toLowerCase().replace(/^meteosat[- _]?/, 'met')
}

function geostationaryPlatform(satellite) {
  const normalized = normalizedGeostationaryName(satellite)
  if (/^mtg(?:-i)?1$/i.test(normalized)) return GEOSTATIONARY_PLATFORMS.get('met12')
  return GEOSTATIONARY_PLATFORMS.get(normalized) ?? null
}

function bearingToSubSatellitePoint(latitude, longitude, subSatelliteLongitude) {
  const radians = Math.PI / 180
  const phi = latitude * radians
  const deltaLongitude = (subSatelliteLongitude - longitude) * radians
  const y = Math.sin(deltaLongitude)
  const x = -Math.sin(phi) * Math.cos(deltaLongitude)
  return (Math.atan2(y, x) / radians + 360) % 360
}

export function geostationaryPixelKm(satellite, latitude, longitude, subSatelliteLongitudeOverride) {
  const platform = geostationaryPlatform(satellite)
  if (!platform) return null
  const subSatelliteLongitude = Number.isFinite(subSatelliteLongitudeOverride)
    ? subSatelliteLongitudeOverride
    : platform.subSatelliteLongitude
  const radians = Math.PI / 180
  const cosPsi = Math.cos(latitude * radians) * Math.cos((longitude - subSatelliteLongitude) * radians)
  const psi = Math.acos(Math.min(1, Math.max(-1, cosPsi)))
  const orbitRadiusKm = EARTH_RADIUS_KM + GEOSTATIONARY_ALTITUDE_KM
  const slantRangeKm = Math.sqrt(
    EARTH_RADIUS_KM ** 2 + orbitRadiusKm ** 2 - 2 * EARTH_RADIUS_KM * orbitRadiusKm * cosPsi,
  )
  const viewingZenith = Math.asin(Math.min(1, (orbitRadiusKm / slantRangeKm) * Math.sin(psi)))
  const nadirKm = GEOSTATIONARY_NADIR_KM[platform.generation]
  const angularIfov = nadirKm / GEOSTATIONARY_ALTITUDE_KM

  // Across the line of sight the pixel only grows with slant range. Along it, the
  // ground projection is stretched by the cosine of the viewing zenith angle.
  const acrossKm = angularIfov * slantRangeKm
  const alongKm = acrossKm / Math.cos(viewingZenith)

  return {
    scanKm: acrossKm,
    trackKm: alongKm,
    viewingZenithDeg: viewingZenith / radians,
    areaHa: acrossKm * alongKm * 100,
    footprintBearingDeg: bearingToSubSatellitePoint(latitude, longitude, subSatelliteLongitude),
    generation: platform.generation,
    subSatelliteLongitude,
  }
}

// WGS84 local scale, so the grid union is computed in metres rather than in
// degrees. Both formulas are the standard truncated series.
function metresPerDegreeLatitude(latitude) {
  const phi = (latitude * Math.PI) / 180
  return 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi)
}

function metresPerDegreeLongitude(latitude) {
  const phi = (latitude * Math.PI) / 180
  return 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi)
}

/**
 * Build one request per sensor. FIRMS keys are supplied only to import scripts
 * or the server route, so the key is never bundled or written to the repository.
 */
export function buildFirmsRequests({ mapKey, bbox, startDate, dayRange = 2, sensors = FIRMS_SENSORS }) {
  if (!mapKey) throw new Error('A FIRMS MAP_KEY is required')
  if (!bbox || bbox.length !== 4) throw new Error('bbox must be [minLon, minLat, maxLon, maxLat]')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate ?? '')) throw new Error('startDate must be YYYY-MM-DD')
  if (!Number.isInteger(dayRange) || dayRange < 1) {
    throw new Error('dayRange must be a positive integer')
  }
  for (const sensor of sensors) {
    const cap = sensor.maxDayRange ?? MAX_DAY_RANGE
    if (dayRange > cap) {
      throw new Error(`${sensor.name} accepts a dayRange of at most ${cap}, received ${dayRange}`)
    }
  }

  const area = bbox.join(',')
  return sensors.map((sensor) => ({
    sensor,
    url: `${FIRMS_API_ROOT}/${mapKey}/${sensor.apiSource}/${area}/${dayRange}/${startDate}`,
    // The same request without the key, safe to display and to record as the
    // audit trail for a plotted detection set.
    citableUrl: `${FIRMS_API_ROOT}/MAP_KEY/${sensor.apiSource}/${area}/${dayRange}/${startDate}`,
  }))
}

function labelForPercent(percent, rawValue) {
  if (!Number.isFinite(percent)) return { label: 'unknown', rank: 0, raw: rawValue }
  if (percent >= 80) return { label: 'high', rank: 3, raw: rawValue }
  if (percent >= 30) return { label: 'nominal', rank: 2, raw: rawValue }
  return { label: 'low', rank: 1, raw: rawValue }
}

function normaliseConfidence(rawValue, instrument, satellite) {
  const value = String(rawValue ?? '').trim().toLowerCase()
  if (!value) return { label: 'unknown', rank: 0, raw: rawValue ?? null }

  if (instrument === 'GEO') {
    // The two Meteosat generations disagree on units: MTG (Met12) publishes a
    // 0-1 fraction, the older MSG spacecraft (Met9, Met10) publish 0-100. Both
    // were confirmed against a day of real detections. Keying on the spacecraft
    // rather than on the magnitude matters, because a genuine 1 percent from an
    // MSG satellite would otherwise be read as total certainty.
    const number = Number(value)
    if (!Number.isFinite(number)) return { label: 'unknown', rank: 0, raw: rawValue }
    const isFractionalScale = geostationaryPlatform(satellite)?.generation === 'mtg'
    return labelForPercent(isFractionalScale ? number * 100 : number, number)
  }

  if (instrument === 'MODIS') {
    // MODIS publishes a 0-100 integer.
    const percent = Number(value)
    if (!Number.isFinite(percent)) return { label: 'unknown', rank: 0, raw: rawValue }
    if (percent >= 80) return { label: 'high', rank: 3, raw: percent }
    if (percent >= 30) return { label: 'nominal', rank: 2, raw: percent }
    return { label: 'low', rank: 1, raw: percent }
  }

  // VIIRS publishes l / n / h, sometimes spelled out.
  if (value === 'h' || value === 'high') return { label: 'high', rank: 3, raw: rawValue }
  if (value === 'n' || value === 'nominal') return { label: 'nominal', rank: 2, raw: rawValue }
  if (value === 'l' || value === 'low') return { label: 'low', rank: 1, raw: rawValue }
  return { label: 'unknown', rank: 0, raw: rawValue }
}

function toIsoTimestamp(acquiredDate, acquiredTime) {
  // FIRMS publishes acq_time as HHMM in UTC, occasionally without the leading zero.
  const padded = String(acquiredTime ?? '').padStart(4, '0')
  const hours = padded.slice(0, 2)
  const minutes = padded.slice(2, 4)
  return `${acquiredDate}T${hours}:${minutes}:00.000Z`
}

/**
 * Parse a FIRMS area CSV response. Unknown or malformed rows are dropped rather
 * than guessed at, and the count of dropped rows is reported by the caller's
 * summary so a partial parse can never be mistaken for a complete one.
 */
export function parseFirmsCsv(csvText, sensor) {
  const lines = String(csvText ?? '').trim().split(/\r?\n/).filter((line) => line.length)
  if (lines.length < 2) return { detections: [], skippedRows: 0 }

  const headers = lines[0].split(',').map((header) => header.trim())
  const indexOf = (name) => headers.indexOf(name)
  const latitudeIndex = indexOf('latitude')
  const longitudeIndex = indexOf('longitude')
  const scanIndex = indexOf('scan')
  const trackIndex = indexOf('track')
  const dateIndex = indexOf('acq_date')
  const timeIndex = indexOf('acq_time')
  const confidenceIndex = indexOf('confidence')
  const frpIndex = indexOf('frp')
  const dayNightIndex = indexOf('daynight')
  const satelliteIndex = indexOf('satellite')
  // VIIRS reports bright_ti4, MODIS reports brightness.
  const brightnessIndex = indexOf('bright_ti4') >= 0 ? indexOf('bright_ti4') : indexOf('brightness')

  if (latitudeIndex < 0 || longitudeIndex < 0) {
    throw new Error('FIRMS response did not contain latitude and longitude columns')
  }

  const detections = []
  let skippedRows = 0

  for (const line of lines.slice(1)) {
    const cells = line.split(',')
    const latitude = Number(cells[latitudeIndex])
    const longitude = Number(cells[longitudeIndex])
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      skippedRows += 1
      continue
    }

    // Polar products publish scan/track dimensions in kilometres. GOES_NRT
    // reuses those columns for geostationary image-grid coordinates (or zero),
    // so they must never be interpreted as kilometres for a GEO row.
    const scanKm = Number(cells[scanIndex])
    const trackKm = Number(cells[trackIndex])
    const nominalKm = sensor.nominalResolutionM / 1000
    const isGeostationary = sensor.instrument === 'GEO'
    const hasPublishedFootprint = !isGeostationary
      && Number.isFinite(scanKm) && Number.isFinite(trackKm) && scanKm > 0 && trackKm > 0
    // A GEO footprint is always computed from the spacecraft/service geometry;
    // raw scan/track values remain separately retained for audit.
    const geostationaryPixel = isGeostationary
      ? geostationaryPixelKm(cells[satelliteIndex], latitude, longitude)
      : null

    detections.push({
      latitude,
      longitude,
      scanKm: hasPublishedFootprint ? scanKm : (geostationaryPixel?.scanKm ?? nominalKm),
      trackKm: hasPublishedFootprint ? trackKm : (geostationaryPixel?.trackKm ?? nominalKm),
      sourceScan: Number.isFinite(scanKm) ? scanKm : null,
      sourceTrack: Number.isFinite(trackKm) ? trackKm : null,
      sourceScanTrackMeaning: isGeostationary ? 'GOES_NRT image-grid fields; not kilometre dimensions' : 'published kilometre dimensions',
      footprintSource: hasPublishedFootprint
        ? 'published'
        : (geostationaryPixel ? 'computed-geostationary' : 'nominal'),
      displayMode: geostationaryPixel || sensor.instrument !== 'GEO' ? 'footprint' : 'centroid',
      footprintBearingDeg: geostationaryPixel?.footprintBearingDeg ?? null,
      viewingZenithDeg: geostationaryPixel?.viewingZenithDeg ?? null,
      subSatelliteLongitude: geostationaryPixel?.subSatelliteLongitude ?? null,
      footprintMethod: geostationaryPixel
        ? 'Approximate local tangent-plane projection from native nadir sampling, spacecraft service longitude and viewing geometry'
        : null,
      acquiredAt: toIsoTimestamp(cells[dateIndex], cells[timeIndex]),
      confidence: normaliseConfidence(cells[confidenceIndex], sensor.instrument, cells[satelliteIndex]),
      frpMw: Number.isFinite(Number(cells[frpIndex])) ? Number(cells[frpIndex]) : null,
      brightnessK: Number.isFinite(Number(cells[brightnessIndex])) ? Number(cells[brightnessIndex]) : null,
      dayNight: cells[dayNightIndex]?.trim() || null,
      satellite: cells[satelliteIndex]?.trim() || sensor.platform,
      sensorKey: sensor.key,
    })
  }

  return { detections, skippedRows }
}

/**
 * The sensor pixel footprint as a closed ring in Leaflet [latitude, longitude]
 * order, matching the convention used by the bundled EFFIS geometry.
 */
export function detectionFootprint(detection) {
  if (!Number.isFinite(detection.scanKm) || !Number.isFinite(detection.trackKm)
    || detection.scanKm <= 0 || detection.trackKm <= 0) return null

  if (Number.isFinite(detection.footprintBearingDeg)) {
    const radians = Math.PI / 180
    const bearing = detection.footprintBearingDeg * radians
    const along = detection.trackKm * 1000 / 2
    const across = detection.scanKm * 1000 / 2
    const alongEast = Math.sin(bearing) * along
    const alongNorth = Math.cos(bearing) * along
    const acrossEast = Math.sin(bearing + Math.PI / 2) * across
    const acrossNorth = Math.cos(bearing + Math.PI / 2) * across
    const metresLatitude = metresPerDegreeLatitude(detection.latitude)
    const metresLongitude = metresPerDegreeLongitude(detection.latitude)
    const point = (east, north) => [
      detection.latitude + north / metresLatitude,
      detection.longitude + east / metresLongitude,
    ]
    const ring = [
      point(-alongEast - acrossEast, -alongNorth - acrossNorth),
      point(-alongEast + acrossEast, -alongNorth + acrossNorth),
      point(alongEast + acrossEast, alongNorth + acrossNorth),
      point(alongEast - acrossEast, alongNorth - acrossNorth),
    ]
    return [...ring, ring[0]]
  }

  const halfLat = detection.trackKm * 1000 / 2 / metresPerDegreeLatitude(detection.latitude)
  const halfLon = detection.scanKm * 1000 / 2 / metresPerDegreeLongitude(detection.latitude)
  const south = detection.latitude - halfLat
  const north = detection.latitude + halfLat
  const west = detection.longitude - halfLon
  const east = detection.longitude + halfLon
  return [[south, west], [south, east], [north, east], [north, west], [south, west]]
}

/**
 * Grid-union hectare estimate.
 *
 * Footprints from repeated overpasses overlap heavily, so summing them counts
 * the same ground many times. This rasterises every footprint onto a fixed grid
 * and measures the occupied cells, which dissolves the overlap. The result is
 * reported alongside the naive sum so the amount of overlap stays visible.
 */
function addDetectionCells(occupied, detection, projection, gridCellM) {
  const halfHeight = detection.trackKm * 1000 / 2
  const halfWidth = detection.scanKm * 1000 / 2
  const centreY = (detection.latitude - projection.anchorLat) * projection.mPerLat
  const centreX = (detection.longitude - projection.anchorLon) * projection.mPerLon
  const south = centreY - halfHeight
  const north = centreY + halfHeight
  const west = centreX - halfWidth
  const east = centreX + halfWidth

  // A cell counts when its centre falls inside the footprint, tested on a
  // half-open interval. Expanding to every touched cell instead would inflate
  // every footprint by up to one cell on each edge, which biases the estimate
  // upward; centre sampling is unbiased and exact when the footprint is a
  // whole number of cells.
  for (let cellY = Math.floor(south / gridCellM); cellY <= Math.ceil(north / gridCellM); cellY += 1) {
    const centreOfCellY = (cellY + 0.5) * gridCellM
    if (centreOfCellY < south - CELL_EDGE_EPSILON_M || centreOfCellY >= north - CELL_EDGE_EPSILON_M) continue
    for (let cellX = Math.floor(west / gridCellM); cellX <= Math.ceil(east / gridCellM); cellX += 1) {
      const centreOfCellX = (cellX + 0.5) * gridCellM
      if (centreOfCellX < west - CELL_EDGE_EPSILON_M || centreOfCellX >= east - CELL_EDGE_EPSILON_M) continue
      occupied.add(`${cellX}:${cellY}`)
    }
  }
}

function pointInPolygon([x, y], polygon) {
  let inside = false
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const [currentX, currentY] = polygon[current]
    const [previousX, previousY] = polygon[previous]
    const crosses = (currentY > y) !== (previousY > y)
      && x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX
    if (crosses) inside = !inside
  }
  return inside
}

function addSupportPolygonCells(occupied, supportPolygons, projection, gridCellM) {
  supportPolygons.forEach((latLonPolygon) => {
    if (!Array.isArray(latLonPolygon) || latLonPolygon.length < 4) return
    const polygon = latLonPolygon
      .map((position) => [
        (Number(position?.[1]) - projection.anchorLon) * projection.mPerLon,
        (Number(position?.[0]) - projection.anchorLat) * projection.mPerLat,
      ])
      .filter((position) => position.every(Number.isFinite))
    if (polygon.length < 4) return

    const xValues = polygon.map(([x]) => x)
    const yValues = polygon.map(([, y]) => y)
    const minCellX = Math.floor(Math.min(...xValues) / gridCellM) - 1
    const maxCellX = Math.ceil(Math.max(...xValues) / gridCellM) + 1
    const minCellY = Math.floor(Math.min(...yValues) / gridCellM) - 1
    const maxCellY = Math.ceil(Math.max(...yValues) / gridCellM) + 1

    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        if (pointInPolygon([(cellX + 0.5) * gridCellM, (cellY + 0.5) * gridCellM], polygon)) {
          occupied.add(`${cellX}:${cellY}`)
        }
      }
    }

    // Include the boundary itself even when a narrow supported lobe contains no
    // cell centre. Sampling at a quarter cell keeps the line connected without
    // inventing a wider buffer around the aircraft evidence.
    for (let index = 1; index < polygon.length; index += 1) {
      const start = polygon[index - 1]
      const end = polygon[index]
      const segmentLength = Math.hypot(end[0] - start[0], end[1] - start[1])
      const steps = Math.max(1, Math.ceil(segmentLength / (gridCellM / 4)))
      for (let step = 0; step <= steps; step += 1) {
        const ratio = step / steps
        const x = start[0] + (end[0] - start[0]) * ratio
        const y = start[1] + (end[1] - start[1]) * ratio
        occupied.add(`${Math.floor(x / gridCellM)}:${Math.floor(y / gridCellM)}`)
      }
    }
  })
}

function addDirectSupportCells(occupied, supportCells) {
  for (const cell of supportCells) {
    if (!Array.isArray(cell) || cell.length !== 2) continue
    const x = Number(cell[0])
    const y = Number(cell[1])
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue
    occupied.add(`${x}:${y}`)
  }
}

function rasterizedFootprintUnion(detections, {
  gridCellM,
  origin,
  supportPolygons = [],
  supportCells = [],
}) {
  const anchorLat = origin?.latitude ?? detections[0].latitude
  const anchorLon = origin?.longitude ?? detections[0].longitude
  const projection = {
    anchorLat,
    anchorLon,
    mPerLat: metresPerDegreeLatitude(anchorLat),
    mPerLon: metresPerDegreeLongitude(anchorLat),
  }
  const occupied = new Set()
  detections.forEach((detection) => addDetectionCells(occupied, detection, projection, gridCellM))
  const sensorCellCount = occupied.size
  addSupportPolygonCells(occupied, supportPolygons, projection, gridCellM)
  const polygonSupportCellCount = occupied.size - sensorCellCount
  addDirectSupportCells(occupied, supportCells)
  return {
    occupied,
    projection,
    sensorCellCount,
    supportCellCount: occupied.size - sensorCellCount,
    polygonSupportCellCount,
    directSupportCellCount: occupied.size - sensorCellCount - polygonSupportCellCount,
  }
}

export function estimateFootprintArea(detections, {
  gridCellM = 25,
  origin,
  supportPolygons = [],
  supportCells = [],
} = {}) {
  const hasSupport = supportPolygons.some((polygon) => Array.isArray(polygon) && polygon.length >= 4)
    || supportCells.some((cell) => Array.isArray(cell) && cell.length === 2)
  const method = `Union of published sensor pixel footprints${hasSupport ? ' and qualifying support geometry' : ''}, dissolved on a ${gridCellM} m grid`

  if (!detections.length) {
    return {
      unionHa: 0,
      sumHa: 0,
      overlapFactor: null,
      detectionCount: 0,
      sensorUnionHa: 0,
      supportCellCount: 0,
      polygonSupportCellCount: 0,
      directSupportCellCount: 0,
      polygonSupportAreaHa: 0,
      directSupportAreaHa: 0,
      supportAreaHa: 0,
      gridCellM,
      method,
      isEstimate: true,
      isBurnedArea: false,
    }
  }

  let sumSquareMetres = 0
  for (const detection of detections) {
    sumSquareMetres += detection.scanKm * detection.trackKm * 1e6
  }

  const {
    occupied,
    sensorCellCount,
    supportCellCount,
    polygonSupportCellCount,
    directSupportCellCount,
  } = rasterizedFootprintUnion(detections, {
    gridCellM,
    origin,
    supportPolygons,
    supportCells,
  })
  const unionHa = occupied.size * gridCellM * gridCellM / 10000
  const sensorUnionHa = sensorCellCount * gridCellM * gridCellM / 10000
  const supportAreaHa = supportCellCount * gridCellM * gridCellM / 10000
  const sumHa = sumSquareMetres / 10000

  return {
    unionHa,
    sumHa,
    overlapFactor: sensorUnionHa > 0 ? sumHa / sensorUnionHa : null,
    detectionCount: detections.length,
    sensorUnionHa,
    supportCellCount,
    polygonSupportCellCount,
    directSupportCellCount,
    polygonSupportAreaHa: polygonSupportCellCount * gridCellM * gridCellM / 10000,
    directSupportAreaHa: directSupportCellCount * gridCellM * gridCellM / 10000,
    supportAreaHa,
    gridCellM,
    method,
    isEstimate: true,
    isBurnedArea: false,
  }
}

/**
 * Everything the interface needs to render one sensor as its own layer, with the
 * hectare estimate inseparable from the method and source that produced it.
 */
const CONFIDENCE_RANKS = { low: 1, nominal: 2, high: 3 }
export const GEOSTATIONARY_DISPLAY_WINDOW_MS = 15 * 60 * 1000

/**
 * Polar detections remain as historical evidence after an overpass. A
 * geostationary detection is an instantaneous heat observation, so keeping it
 * forever would turn repeated coarse pixels into a false burned-area layer.
 */
export function firmsDetectionVisibleAt(detection, selectedTimestampMs) {
  const acquiredAtMs = Number.isFinite(detection.timestampMs)
    ? detection.timestampMs
    : Date.parse(detection.acquiredAt)
  if (!Number.isFinite(acquiredAtMs) || acquiredAtMs > selectedTimestampMs) return false
  return detection.sensorKey !== 'meteosat'
    || selectedTimestampMs - acquiredAtMs < GEOSTATIONARY_DISPLAY_WINDOW_MS
}

/**
 * Whether a detection clears a confidence threshold. Exported so that a stored
 * snapshot can tag every detection it carries with the same test used to produce
 * its counts: a point that is drawn but not counted, or counted but not drawn,
 * would misrepresent the estimate.
 */
export function meetsConfidence(detection, minimumConfidence = 'low') {
  return detection.confidence.rank >= (CONFIDENCE_RANKS[minimumConfidence] ?? 1)
}

export function summarizeSensorDetections({ sensor, detections, skippedRows = 0, requestUrl, retrievedAt, minimumConfidence = 'low', origin }) {
  const retained = detections.filter((detection) => meetsConfidence(detection, minimumConfidence))
  const providesArea = sensor.providesArea === true

  const confidenceCounts = { low: 0, nominal: 0, high: 0, unknown: 0 }
  for (const detection of detections) confidenceCounts[detection.confidence.label] += 1

  const timestamps = retained.map((detection) => detection.acquiredAt).sort()
  const frpValues = retained.map((detection) => detection.frpMw).filter((value) => Number.isFinite(value))
  const area = providesArea ? estimateFootprintArea(retained, { origin }) : null
  const nominalFootprintHa = providesArea
    ? (sensor.nominalResolutionM / 1000) ** 2 * 100
    : null

  // The published pixel dimensions grow with scan angle, so an overpass near the
  // swath edge inflates every footprint. Reporting the observed mean pixel
  // against the nominal one makes that inflation visible instead of burying it
  // inside the hectare figure.
  const observedPixelAreas = providesArea
    ? retained.map((detection) => detection.scanKm * detection.trackKm * 100)
    : []
  const meanPixelHa = observedPixelAreas.length
    ? observedPixelAreas.reduce((total, value) => total + value, 0) / observedPixelAreas.length
    : null

  // The same union recomputed at each confidence threshold. A single hectare
  // number would hide how strongly the figure depends on a threshold choice, so
  // all three travel together and the caller states which one it displays.
  const areaHaByConfidence = providesArea ? {} : null
  if (providesArea) {
    for (const level of ['low', 'nominal', 'high']) {
      areaHaByConfidence[level] = estimateFootprintArea(
        detections.filter((detection) => meetsConfidence(detection, level)),
        { origin },
      ).unionHa
    }
  }

  // The same union using nominal pixels instead of the published ones, which
  // isolates how much of the estimate comes from scan-angle growth alone.
  const nominalPixelAreaHa = providesArea
    ? estimateFootprintArea(
        retained.map((detection) => ({
          ...detection,
          scanKm: sensor.nominalResolutionM / 1000,
          trackKm: sensor.nominalResolutionM / 1000,
        })),
        { origin },
      ).unionHa
    : null

  return {
    sensorKey: sensor.key,
    sensorName: sensor.name,
    platform: sensor.platform,
    instrument: sensor.instrument,
    nominalResolutionM: sensor.nominalResolutionM,
    color: sensor.color,
    providesArea,
    areaDerivationAllowed: providesArea,
    areaExclusionReason: providesArea ? null : sensor.areaExclusionReason,
    displayMode: sensor.displayMode ?? 'footprint',
    pixelSizeLabel: sensor.pixelSizeLabel ?? `${sensor.nominalResolutionM} m nominal pixel`,

    detectionCount: retained.length,
    droppedByConfidence: detections.length - retained.length,
    skippedRows,
    confidenceCounts,
    minimumConfidence,
    firstAcquiredAt: timestamps[0] ?? null,
    lastAcquiredAt: timestamps[timestamps.length - 1] ?? null,
    totalFrpMw: frpValues.length ? frpValues.reduce((total, value) => total + value, 0) : null,
    maxFrpMw: frpValues.length ? Math.max(...frpValues) : null,

    // The estimate and its label travel together.
    areaHa: area?.unionHa ?? null,
    areaMethod: area?.method ?? null,
    areaIsEstimate: providesArea ? true : null,
    areaLabel: providesArea ? `${sensor.name} detection footprint (estimate)` : `${sensor.name} detections only`,
    areaDisclaimer: providesArea
      ? 'Derived from thermal-anomaly footprints. Not a burned area, not a perimeter and not an official affected-area figure.'
      : sensor.areaExclusionReason,
    footprintSumHa: area?.sumHa ?? null,
    footprintOverlapFactor: area?.overlapFactor ?? null,
    singlePixelHa: nominalFootprintHa,
    meanPixelHa,
    pixelInflationFactor: meanPixelHa && nominalFootprintHa ? meanPixelHa / nominalFootprintHa : null,
    areaHaByConfidence,
    nominalPixelAreaHa,
    gridCellM: area?.gridCellM ?? null,

    source: 'NASA FIRMS',
    sourceUrl: FIRMS_SOURCE_URL,
    sourceKeyUrl: FIRMS_KEY_URL,
    sourceRequestUrl: requestUrl ?? null,
    retrievedAt: retrievedAt ?? null,
    caveats: FOOTPRINT_ESTIMATE_CAVEATS,
  }
}

/** Source-panel entry, matching the shape used by the bundled source list. */
export function firmsSourceEntry(summaries) {
  const plotted = summaries.reduce((total, summary) => total + summary.detectionCount, 0)
  const connected = summaries.filter((summary) => summary.detectionCount > 0)
  const areaCapable = connected.filter((summary) => summary.providesArea)
  return {
    name: 'NASA FIRMS',
    detail: plotted
      ? `${plotted} detections from ${connected.length} sensor${connected.length === 1 ? '' : 's'}; standalone area is derived only for ${areaCapable.length} VIIRS product${areaCapable.length === 1 ? '' : 's'}`
      : 'No detections in the selected snapshot or server response',
    cadence: 'Polar overpasses plus 10-minute MTG and 15-minute MSG scans; provider latency varies',
    url: FIRMS_SOURCE_URL,
    tone: 'nasa',
  }
}

/**
 * Trace one coherent boundary around a set of detection footprints.
 *
 * The map otherwise draws hundreds of separate pixel rectangles, which reads as
 * texture rather than as a fire. This rasterises the same footprints used for the
 * area figure, then walks the edges of the occupied region to produce closed
 * rings that can be drawn as a single outline.
 *
 * Interior holes are returned as their own rings and are NOT filled in. That is
 * the difference between this outline and the EFFIS envelope: unburned ground
 * enclosed by detections stays visibly unburned.
 */
export function footprintOutlineRings(detections, {
  gridCellM = 50,
  origin,
  supportPolygons = [],
  supportCells = [],
} = {}) {
  if (!detections.length) return []

  // Same occupancy test as estimateFootprintArea, so the outline and the hectare
  // figure always describe the same ground.
  const { occupied, projection } = rasterizedFootprintUnion(detections, {
    gridCellM,
    origin,
    supportPolygons,
    supportCells,
  })
  const { anchorLat, anchorLon, mPerLat, mPerLon } = projection

  // A cell side is on the boundary when the neighbour across it is empty. Each
  // side is emitted with the occupied cell on its left, so following edges
  // head-to-tail traces a closed loop without needing any orientation test.
  const edges = new Map()
  const addEdge = (fromX, fromY, toX, toY) => {
    const key = `${fromX}:${fromY}`
    if (!edges.has(key)) edges.set(key, [])
    edges.get(key).push([toX, toY])
  }
  for (const cell of occupied) {
    const [x, y] = cell.split(':').map(Number)
    if (!occupied.has(`${x}:${y - 1}`)) addEdge(x, y, x + 1, y)
    if (!occupied.has(`${x + 1}:${y}`)) addEdge(x + 1, y, x + 1, y + 1)
    if (!occupied.has(`${x}:${y + 1}`)) addEdge(x + 1, y + 1, x, y + 1)
    if (!occupied.has(`${x - 1}:${y}`)) addEdge(x, y + 1, x, y)
  }

  const toLatLon = ([x, y]) => [
    anchorLat + (y * gridCellM) / mPerLat,
    anchorLon + (x * gridCellM) / mPerLon,
  ]

  // Grid-aligned rings run in long straight stretches, so dropping collinear
  // vertices is lossless and removes most of the points.
  const dropCollinear = (points) => points.filter((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length]
    const next = points[(index + 1) % points.length]
    const crossProduct = (point[0] - previous[0]) * (next[1] - previous[1])
      - (point[1] - previous[1]) * (next[0] - previous[0])
    return crossProduct !== 0
  })

  const rings = []
  while (edges.size) {
    const [startKey] = edges.keys()
    const start = startKey.split(':').map(Number)
    const ring = []
    let current = start
    while (true) {
      const key = `${current[0]}:${current[1]}`
      const outgoing = edges.get(key)
      if (!outgoing?.length) break
      const next = outgoing.pop()
      if (!outgoing.length) edges.delete(key)
      ring.push(current)
      current = next
      if (current[0] === start[0] && current[1] === start[1]) break
    }
    // A ring needs three distinct corners to enclose anything.
    if (ring.length >= 4) {
      const simplified = dropCollinear(ring)
      rings.push([...simplified.map(toLatLon), toLatLon(simplified[0])])
    }
  }

  // Largest first, so a renderer drawing in order puts the main burn underneath.
  return rings.sort((left, right) => right.length - left.length)
}
