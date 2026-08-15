#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const SOURCE = {
  name: 'Airplanes.live public globe history',
  url: 'https://globe.airplanes.live/',
  historyRoot: 'https://globe.airplanes.live/globe_history',
}

const DEFAULTS = {
  date: '2026-08-14',
  output: '.local-data/airplanes-live/2026-08-14',
  sourceRoot: SOURCE.historyRoot,
  bounds: {
    minLat: 50.47,
    maxLat: 50.70,
    minLon: 5.90,
    maxLon: 6.25,
  },
}

const CANDIDATES = [
  { callsign: 'G14', registration: 'OO-POC', icao24: '44c1e3' },
  { callsign: 'G15', registration: 'OO-POD', icao24: '44c1e4' },
  { callsign: 'G10', registration: 'OO-POE', icao24: '44c1e5' },
  { callsign: 'G11', registration: 'OO-POG', icao24: '44c1e7' },
  { callsign: 'G12', registration: 'OO-POH', icao24: '44c1e8' },
  { callsign: 'G16', registration: 'OO-POI', icao24: '44c1e9' },
  { callsign: 'G17', registration: 'OO-POJ', icao24: '44c1ea' },
]

const FIVE_MINUTES_MS = 5 * 60 * 1000
const SEGMENT_GAP_MS = 2 * 60 * 1000
// The MD902's published maximum speed is 259 km/h (about 140 kt). The small
// margin avoids splitting a link solely because of MLAT timing/position noise.
const MAX_LINK_SPEED_KT = 160
const DROSSART_REFERENCE = {
  name: 'Drossart locality (OpenStreetMap node 5770188072)',
  latitude: 50.54762,
  longitude: 6.05757,
  url: 'https://www.openstreetmap.org/node/5770188072',
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, bounds: { ...DEFAULTS.bounds }, dryRun: false, help: false }
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (argument === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    const key = argument.replace(/^--/, '')
    const value = argv[index + 1]
    if (!argument.startsWith('--') || value == null) throw new Error(`Unknown or incomplete argument: ${argument}`)
    if (key === 'date' || key === 'output' || key === 'sourceRoot') options[key] = value
    else if (key in options.bounds) options.bounds[key] = Number(value)
    else throw new Error(`Unknown argument: ${argument}`)
    index += 1
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) throw new Error('--date must use YYYY-MM-DD')
  for (const [name, value] of Object.entries(options.bounds)) {
    if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`)
  }
  return options
}

function historyUrl(sourceRoot, date, icao24) {
  const datePath = date.replaceAll('-', '/')
  return `${sourceRoot.replace(/\/$/, '')}/${datePath}/traces/${icao24.slice(-2)}/trace_full_${icao24}.json`
}

function sourceFor(sourceRoot) {
  if (sourceRoot.includes('adsb.lol')) {
    return { name: 'ADSB.lol public globe history', url: 'https://adsb.lol/', historyRoot: sourceRoot }
  }
  return { ...SOURCE, historyRoot: sourceRoot }
}

function printHelp() {
  process.stdout.write(`Public ADS-B globe-history importer\n\n`)
  process.stdout.write(`Usage: pnpm import:public-adsb -- [options]\n\n`)
  process.stdout.write(`  --date <YYYY-MM-DD>  UTC history day (${DEFAULTS.date})\n`)
  process.stdout.write(`  --output <path>      Local ignored output directory (${DEFAULTS.output})\n`)
  process.stdout.write(`  --sourceRoot <url>   tar1090 globe-history root (${DEFAULTS.sourceRoot})\n`)
  process.stdout.write(`  --dry-run            Print the Belgian Police fleet URLs without fetching them\n`)
  process.stdout.write(`  --help               Show this help\n`)
}

function numeric(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function parseTrace(body, candidate) {
  const baseTimestampMs = numeric(body.timestamp) * 1000
  if (!Number.isFinite(baseTimestampMs)) throw new Error(`${candidate.icao24} has no valid trace timestamp`)

  const seen = new Set()
  const positions = (Array.isArray(body.trace) ? body.trace : [])
    .map((row) => {
      if (!Array.isArray(row)) return null
      const offsetSeconds = numeric(row[0])
      const latitude = numeric(row[1])
      const longitude = numeric(row[2])
      if (offsetSeconds == null || latitude == null || longitude == null) return null
      const metadata = row[8] && typeof row[8] === 'object' ? row[8] : null
      const altitudeHundredsFt = typeof row[3] === 'number' ? row[3] / 100 : null
      const timestampMs = baseTimestampMs + offsetSeconds * 1000
      return {
        timestamp: new Date(timestampMs).toISOString(),
        timestampMs,
        latitude,
        longitude,
        altitudeFt: typeof row[3] === 'number' ? row[3] : null,
        altitudeHundredsFt,
        groundspeedKt: numeric(row[4]),
        headingDeg: numeric(row[5]),
        verticalRateFpm: numeric(row[7]),
        callsign: String(metadata?.flight || candidate.callsign).trim(),
        squawk: metadata?.squawk ?? null,
        updateType: String(row[9] || metadata?.type || 'unknown').toLowerCase(),
      }
    })
    .filter(Boolean)
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .filter((position) => {
      const key = `${position.timestampMs}:${position.latitude}:${position.longitude}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  return positions.map((position, index) => {
    const previous = positions[index - 1]
    if (!previous) return { ...position, impliedFromPreviousKt: null, linkQuality: 'first' }
    const elapsedHours = (position.timestampMs - previous.timestampMs) / (60 * 60 * 1000)
    const impliedFromPreviousKt = elapsedHours > 0
      ? haversineKm(previous, position) / 1.852 / elapsedHours
      : Number.POSITIVE_INFINITY
    return {
      ...position,
      impliedFromPreviousKt,
      linkQuality: impliedFromPreviousKt <= MAX_LINK_SPEED_KT ? 'plausible' : 'split-outlier',
    }
  })
}

function insideBounds(position, bounds) {
  return position.latitude >= bounds.minLat
    && position.latitude <= bounds.maxLat
    && position.longitude >= bounds.minLon
    && position.longitude <= bounds.maxLon
}

function sampleFiveMinutes(positions) {
  const buckets = new Map()
  for (const position of positions) {
    const bucket = Math.floor(position.timestampMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS
    if (!buckets.has(bucket)) buckets.set(bucket, [])
    buckets.get(bucket).push(position)
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([bucket, bucketPositions]) => {
      const midpoint = bucket + FIVE_MINUTES_MS / 2
      const position = bucketPositions
        .map((candidate) => ({
          candidate,
          totalDistance: bucketPositions.reduce((sum, other) => sum + haversineKm(candidate, other), 0),
        }))
        .sort((left, right) => left.totalDistance - right.totalDistance
          || Math.abs(left.candidate.timestampMs - midpoint) - Math.abs(right.candidate.timestampMs - midpoint))[0].candidate
      return { ...position, bucket: new Date(bucket).toISOString(), bucketObservationCount: bucketPositions.length }
    })
}

function splitSegments(positions) {
  const segments = []
  let current = []
  for (const position of positions) {
    const previous = current.at(-1)
    if (previous && (position.timestampMs - previous.timestampMs > SEGMENT_GAP_MS || position.linkQuality === 'split-outlier')) {
      if (current.length >= 2) segments.push(current)
      current = []
    }
    current.push(position)
  }
  if (current.length >= 2) segments.push(current)
  return segments
}

function haversineKm(left, right) {
  const radians = Math.PI / 180
  const deltaLat = (right.latitude - left.latitude) * radians
  const deltaLon = (right.longitude - left.longitude) * radians
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(left.latitude * radians) * Math.cos(right.latitude * radians) * Math.sin(deltaLon / 2) ** 2
  return 6371.0088 * 2 * Math.asin(Math.sqrt(value))
}

function boundsFor(positions) {
  if (!positions.length) return null
  return {
    minLat: Math.min(...positions.map((position) => position.latitude)),
    maxLat: Math.max(...positions.map((position) => position.latitude)),
    minLon: Math.min(...positions.map((position) => position.longitude)),
    maxLon: Math.max(...positions.map((position) => position.longitude)),
  }
}

function csvCell(value) {
  if (value == null) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function observationsCsv(flights, source) {
  const rows = [[
    'icao24', 'callsign', 'registration', 'five_minute_bucket_utc', 'observed_at_utc',
    'latitude', 'longitude', 'altitude_ft', 'groundspeed_kt', 'heading_deg',
    'vertical_rate_fpm', 'squawk', 'update_type', 'inside_search_area',
    'bucket_observation_count', 'implied_from_previous_kt', 'link_quality',
    'mission_status', 'source',
  ]]
  for (const flight of flights) {
    for (const position of flight.fiveMinutePositions) {
      rows.push([
        flight.icao24, position.callsign || flight.callsign, flight.registration,
        position.bucket, position.timestamp, position.latitude, position.longitude,
        position.altitudeFt, position.groundspeedKt, position.headingDeg,
        position.verticalRateFpm, position.squawk, position.updateType,
        insideBounds(position, flight.searchBounds), position.bucketObservationCount,
        position.impliedFromPreviousKt == null ? null : position.impliedFromPreviousKt.toFixed(1),
        position.linkQuality, 'unconfirmed', source.name,
      ])
    }
  }
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`
}

function observationsGeoJson(flights, source) {
  return {
    type: 'FeatureCollection',
    name: 'Public ADS-B/MLAT observations (not interpolated)',
    features: flights.flatMap((flight) => flight.positions.map((position) => ({
      type: 'Feature',
      properties: {
        icao24: flight.icao24,
        callsign: position.callsign || flight.callsign,
        registration: flight.registration,
        observed_at: position.timestamp,
        altitude_ft: position.altitudeFt,
        groundspeed_kt: position.groundspeedKt,
        heading_deg: position.headingDeg,
        update_type: position.updateType,
        implied_from_previous_kt: position.impliedFromPreviousKt,
        link_quality: position.linkQuality,
        inside_search_area: insideBounds(position, flight.searchBounds),
        source: source.name,
        mission_status: 'unconfirmed',
      },
      geometry: {
        type: 'Point',
        coordinates: [position.longitude, position.latitude],
      },
    }))),
  }
}

function segmentsGeoJson(flights, source) {
  return {
    type: 'FeatureCollection',
    name: 'Public observed ADS-B/MLAT segments (mission association unconfirmed)',
    features: flights.flatMap((flight) => flight.segments.map((segment, index) => ({
      type: 'Feature',
      properties: {
        icao24: flight.icao24,
        callsign: segment.find((point) => point.callsign)?.callsign || flight.callsign,
        registration: flight.registration,
        segment: index + 1,
        observed_start: segment[0].timestamp,
        observed_end: segment.at(-1).timestamp,
        observation_count: segment.length,
        coordinateTimes: segment.map((position) => position.timestamp),
        update_types: [...new Set(segment.map((position) => position.updateType))],
        source: source.name,
        mission_status: 'unconfirmed',
      },
      geometry: {
        type: 'LineString',
        coordinates: segment.map((position) => [position.longitude, position.latitude]),
      },
    }))),
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function main() {
  const options = parseArgs(process.argv)
  if (options.help) {
    printHelp()
    return
  }

  const source = sourceFor(options.sourceRoot)
  const urls = CANDIDATES.map((candidate) => ({ ...candidate, url: historyUrl(options.sourceRoot, options.date, candidate.icao24) }))
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ source, date: options.date, requests: urls }, null, 2)}\n`)
    return
  }

  const outputDir = path.resolve(options.output)
  const rawDir = path.join(outputDir, 'raw')
  await mkdir(rawDir, { recursive: true })

  const flights = []
  const errors = []
  const retrievalWarnings = []
  for (const candidate of urls) {
    process.stderr.write(`Fetching ${source.name}: ${candidate.callsign} (${candidate.icao24})\n`)
    const rawPath = path.join(rawDir, `trace-${candidate.icao24}.json`)
    try {
      let body
      let retrievalMode = 'network'
      let sourceResponseSavedAt
      try {
        const response = await fetch(candidate.url, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        body = await response.json()
        await writeJson(rawPath, body)
      } catch (networkError) {
        try {
          const cached = await readFile(rawPath, 'utf8')
          body = JSON.parse(cached)
          retrievalMode = 'local-cache'
          retrievalWarnings.push({
            icao24: candidate.icao24,
            callsign: candidate.callsign,
            detail: `Network retrieval failed; normalized the previously saved raw response (${networkError.message})`,
          })
        } catch {
          throw networkError
        }
      }
      sourceResponseSavedAt = (await stat(rawPath)).mtime.toISOString()
      const positions = parseTrace(body, candidate)
      const fiveMinutePositions = sampleFiveMinutes(positions)
      const drossartPosition = { latitude: DROSSART_REFERENCE.latitude, longitude: DROSSART_REFERENCE.longitude }
      flights.push({
        ...candidate,
        retrievalMode,
        sourceResponseSavedAt,
        sourceRegistration: body.r ?? null,
        searchBounds: options.bounds,
        observationCount: positions.length,
        fiveMinuteObservationCount: fiveMinutePositions.length,
        searchAreaObservationCount: positions.filter((position) => insideBounds(position, options.bounds)).length,
        observationsWithin2KmOfDrossart: positions.filter((position) => haversineKm(position, drossartPosition) <= 2).length,
        nearestDrossartObservationKm: positions.length
          ? Math.min(...positions.map((position) => haversineKm(position, drossartPosition)))
          : null,
        firstObservedAt: positions[0]?.timestamp ?? null,
        lastObservedAt: positions.at(-1)?.timestamp ?? null,
        observedBounds: boundsFor(positions),
        updateTypeCounts: positions.reduce((counts, position) => {
          counts[position.updateType] = (counts[position.updateType] || 0) + 1
          return counts
        }, {}),
        fiveMinutePositions,
        segments: splitSegments(positions),
        positions,
      })
    } catch (error) {
      errors.push({ icao24: candidate.icao24, callsign: candidate.callsign, detail: error.message })
    }
  }

  const manifest = {
    schemaVersion: 1,
    source,
    normalizedAt: new Date().toISOString(),
    date: options.date,
    searchBounds: options.bounds,
    locationReference: DROSSART_REFERENCE,
    errors,
    retrievalWarnings,
    flights: flights.map(({ fiveMinutePositions, segments, positions, searchBounds, ...flight }) => flight),
    interpretation: [
      'All exported coordinates are source observations; no position was interpolated.',
      'The 5-minute CSV selects an actual medoid observation from each UTC bucket and leaves empty buckets empty.',
      `LineStrings are split at gaps longer than 2 minutes or jumps implying more than ${MAX_LINK_SPEED_KT} knots.`,
      'The source labels these positions as MLAT where shown; MLAT is a receiver-derived position, not onboard ADS-B GPS.',
      'A track entering the broad search area would show proximity only, not proof of a firefighting mission.',
    ],
  }

  await writeJson(path.join(outputDir, 'manifest.json'), manifest)
  await writeJson(path.join(outputDir, 'observations.geojson'), observationsGeoJson(flights, source))
  await writeJson(path.join(outputDir, 'track-segments.geojson'), segmentsGeoJson(flights, source))
  await writeFile(path.join(outputDir, 'observations-5m.csv'), observationsCsv(flights, source), 'utf8')

  process.stdout.write(`${JSON.stringify({
    output: outputDir,
    tracksRetrieved: flights.length,
    errors,
    retrievalWarnings,
    flights: manifest.flights,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
