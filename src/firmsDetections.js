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
// each gets its own map layer, its own colour and its own hectare estimate. They
// are never merged into one number: overlapping detections from two satellites
// are two independent observations, not one better observation.
export const FIRMS_SENSORS = [
  {
    key: 'viirsSnpp',
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
    providesArea: false,
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
    name: 'Meteosat (geostationary)',
    platform: 'Met12 / Met10 / Met9',
    instrument: 'GEO',
    // Nominal at nadir. At 50.5 N the pixel is foreshortened to roughly 3x6 km,
    // which is why this sensor never yields an area figure.
    nominalResolutionM: 3000,
    providesArea: false,
    // FIRMS rejects a longer window for this product.
    maxDayRange: 2,
    color: '#7f9bb5',
    tone: 'nasa',
    cadence: 'Continuous; about one scan every 10 minutes',
    retirementNote: 'Pixels are roughly 3x6 km at this latitude. Detections and FRP only; no area is derived from them.',
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
  'Each sensor is estimated independently. Figures from different sensors must not be added together; the same ground observed twice is two observations, not twice the area.',
  'Corroboration records that two spacecraft observed the same cell. It raises confidence that something was burning there; it does not measure how much of the cell burned, and an uncorroborated detection is not thereby proven false.',
]

// Footprints from one scan line abut exactly, so the half-open cell test has to
// tolerate floating-point error on the shared edge. Without this, two touching
// pixels leave an empty one-cell seam between them: the area is understated and
// the outline is cut by spurious slits.
const CELL_EDGE_EPSILON_M = 1e-6

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
    const isFractionalScale = /^met1[1-9]|mtg/i.test(String(satellite ?? ''))
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

    // scan and track are the published pixel dimensions in kilometres. Without
    // them a footprint cannot be drawn, so fall back to the nominal square
    // rather than inventing a size, and record which was used.
    const scanKm = Number(cells[scanIndex])
    const trackKm = Number(cells[trackIndex])
    const nominalKm = sensor.nominalResolutionM / 1000
    const hasPublishedFootprint = Number.isFinite(scanKm) && Number.isFinite(trackKm) && scanKm > 0 && trackKm > 0

    detections.push({
      latitude,
      longitude,
      scanKm: hasPublishedFootprint ? scanKm : nominalKm,
      trackKm: hasPublishedFootprint ? trackKm : nominalKm,
      footprintSource: hasPublishedFootprint ? 'published' : 'nominal',
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
export function estimateFootprintArea(detections, { gridCellM = 25, origin } = {}) {
  const method = `Union of published sensor pixel footprints, dissolved on a ${gridCellM} m grid`

  if (!detections.length) {
    return {
      unionHa: 0,
      sumHa: 0,
      overlapFactor: null,
      detectionCount: 0,
      gridCellM,
      method,
      isEstimate: true,
      isBurnedArea: false,
    }
  }

  const anchorLat = origin?.latitude ?? detections[0].latitude
  const anchorLon = origin?.longitude ?? detections[0].longitude
  const mPerLat = metresPerDegreeLatitude(anchorLat)
  const mPerLon = metresPerDegreeLongitude(anchorLat)

  const occupied = new Set()
  let sumSquareMetres = 0

  for (const detection of detections) {
    sumSquareMetres += detection.scanKm * detection.trackKm * 1e6

    const halfHeight = detection.trackKm * 1000 / 2
    const halfWidth = detection.scanKm * 1000 / 2
    const centreY = (detection.latitude - anchorLat) * mPerLat
    const centreX = (detection.longitude - anchorLon) * mPerLon

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

  const unionHa = occupied.size * gridCellM * gridCellM / 10000
  const sumHa = sumSquareMetres / 10000

  return {
    unionHa,
    sumHa,
    overlapFactor: unionHa > 0 ? sumHa / unionHa : null,
    detectionCount: detections.length,
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

  const confidenceCounts = { low: 0, nominal: 0, high: 0, unknown: 0 }
  for (const detection of detections) confidenceCounts[detection.confidence.label] += 1

  const timestamps = retained.map((detection) => detection.acquiredAt).sort()
  const frpValues = retained.map((detection) => detection.frpMw).filter((value) => Number.isFinite(value))
  const area = estimateFootprintArea(retained, { origin })
  const nominalFootprintHa = (sensor.nominalResolutionM / 1000) ** 2 * 100

  // The published pixel dimensions grow with scan angle, so an overpass near the
  // swath edge inflates every footprint. Reporting the observed mean pixel
  // against the nominal one makes that inflation visible instead of burying it
  // inside the hectare figure.
  const observedPixelAreas = retained.map((detection) => detection.scanKm * detection.trackKm * 100)
  const meanPixelHa = observedPixelAreas.length
    ? observedPixelAreas.reduce((total, value) => total + value, 0) / observedPixelAreas.length
    : null

  // The same union recomputed at each confidence threshold. A single hectare
  // number would hide how strongly the figure depends on a threshold choice, so
  // all three travel together and the caller states which one it displays.
  const areaHaByConfidence = {}
  for (const level of ['low', 'nominal', 'high']) {
    areaHaByConfidence[level] = estimateFootprintArea(
      detections.filter((detection) => meetsConfidence(detection, level)),
      { origin },
    ).unionHa
  }

  // The same union using nominal pixels instead of the published ones, which
  // isolates how much of the estimate comes from scan-angle growth alone.
  const nominalPixelAreaHa = estimateFootprintArea(
    retained.map((detection) => ({
      ...detection,
      scanKm: sensor.nominalResolutionM / 1000,
      trackKm: sensor.nominalResolutionM / 1000,
    })),
    { origin },
  ).unionHa

  return {
    sensorKey: sensor.key,
    sensorName: sensor.name,
    platform: sensor.platform,
    instrument: sensor.instrument,
    nominalResolutionM: sensor.nominalResolutionM,
    color: sensor.color,

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
    areaHa: area.unionHa,
    areaMethod: area.method,
    areaIsEstimate: true,
    areaLabel: `${sensor.name} detection footprint (estimate)`,
    areaDisclaimer: 'Derived from thermal-anomaly footprints. Not a burned area, not a perimeter and not an official affected-area figure.',
    footprintSumHa: area.sumHa,
    footprintOverlapFactor: area.overlapFactor,
    singlePixelHa: nominalFootprintHa,
    meanPixelHa,
    pixelInflationFactor: meanPixelHa ? meanPixelHa / nominalFootprintHa : null,
    areaHaByConfidence,
    nominalPixelAreaHa,
    gridCellM: area.gridCellM,

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
  return {
    name: 'NASA FIRMS',
    detail: plotted
      ? `${plotted} detections from ${connected.length} sensor${connected.length === 1 ? '' : 's'}; hectares are derived estimates`
      : 'No detections in the selected snapshot or server response',
    cadence: 'Roughly 6 to 10 overpasses per day, about 3 h latency',
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
export function footprintOutlineRings(detections, { gridCellM = 50, origin } = {}) {
  if (!detections.length) return []

  const anchorLat = origin?.latitude ?? detections[0].latitude
  const anchorLon = origin?.longitude ?? detections[0].longitude
  const mPerLat = metresPerDegreeLatitude(anchorLat)
  const mPerLon = metresPerDegreeLongitude(anchorLat)

  // Same occupancy test as estimateFootprintArea, so the outline and the hectare
  // figure always describe the same ground.
  const occupied = new Set()
  for (const detection of detections) {
    const halfHeight = detection.trackKm * 1000 / 2
    const halfWidth = detection.scanKm * 1000 / 2
    const centreY = (detection.latitude - anchorLat) * mPerLat
    const centreX = (detection.longitude - anchorLon) * mPerLon
    const south = centreY - halfHeight
    const north = centreY + halfHeight
    const west = centreX - halfWidth
    const east = centreX + halfWidth

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
