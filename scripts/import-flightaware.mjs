#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { stdout } from 'node:process'
import path from 'node:path'

const API_ROOT = 'https://aeroapi.flightaware.com/aeroapi'
const PROVIDER_URL = 'https://www.flightaware.com/commercial/aeroapi/'
const FREE_ALLOWANCE_USD = 5
const DISCOVERY_COST_USD = 0.005
const TRACK_COST_USD = 0.012
const MAX_TRACK_REQUESTS = 6
const MAX_RUN_COST_USD = 0.10
const RAW_RETENTION_DAYS = 30
const FIVE_MINUTES_MS = 5 * 60 * 1000
const SEGMENT_GAP_MS = 10 * 60 * 1000

const DEFAULTS = {
  // Full 14 August local day plus the first three hours of 15 August (CEST, UTC+2).
  start: '2026-08-13T22:00:00Z',
  end: '2026-08-15T01:00:00Z',
  output: '.local-data/flightaware/2026-08-14',
  bounds: {
    minLat: 50.47,
    maxLat: 50.70,
    minLon: 5.90,
    maxLon: 6.25,
  },
}

const DEFAULT_CANDIDATES = [
  {
    label: 'G10 / OO-POE',
    callsign: 'G10',
    registration: 'OO-POE',
    icao24: '44C1E5',
  },
  {
    label: 'G12 / OO-POH',
    callsign: 'G12',
    registration: 'OO-POH',
    icao24: '44C1E8',
  },
]

function parseArgs(argv) {
  const options = {
    ...DEFAULTS,
    bounds: { ...DEFAULTS.bounds },
    dryRun: false,
    help: false,
  }

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

    if (key === 'start' || key === 'end' || key === 'output') {
      options[key] = value
    } else if (key in options.bounds) {
      options.bounds[key] = Number(value)
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
    index += 1
  }

  const startMs = Date.parse(options.start)
  const endMs = Date.parse(options.end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new Error('--start and --end must be valid ISO-8601 values with start before end')
  }
  if (endMs - startMs > 10 * 24 * 60 * 60 * 1000) {
    throw new Error('AeroAPI recent-flight queries are limited to a 10-day window')
  }
  for (const [name, value] of Object.entries(options.bounds)) {
    if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`)
  }
  return options
}

function printHelp() {
  stdout.write(`One-time FlightAware AeroAPI importer\n\n`)
  stdout.write(`Usage: pnpm import:flightaware -- [options]\n\n`)
  stdout.write(`Options:\n`)
  stdout.write(`  --start <ISO>     Inclusive query start (${DEFAULTS.start})\n`)
  stdout.write(`  --end <ISO>       Exclusive query end (${DEFAULTS.end})\n`)
  stdout.write(`  --output <path>   Local ignored output directory (${DEFAULTS.output})\n`)
  stdout.write(`  --minLat <n>      Search-area southern edge (${DEFAULTS.bounds.minLat})\n`)
  stdout.write(`  --maxLat <n>      Search-area northern edge (${DEFAULTS.bounds.maxLat})\n`)
  stdout.write(`  --minLon <n>      Search-area western edge (${DEFAULTS.bounds.minLon})\n`)
  stdout.write(`  --maxLon <n>      Search-area eastern edge (${DEFAULTS.bounds.maxLon})\n`)
  stdout.write(`  --dry-run         Show requests and maximum cost without calling AeroAPI\n`)
  stdout.write(`  --help            Show this help\n\n`)
  stdout.write(`The key is read from FLIGHTAWARE_API_KEY or requested interactively.\n`)
}

function normalizeIdentifier(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function querySpecs() {
  // AeroAPI interprets short values such as G10 as airline designators and rejects
  // them (for example, "operator G1 is unknown"). Registration lookup is explicit
  // and still returns any FlightAware flight whose ATC ident was G10/G12.
  return DEFAULT_CANDIDATES.map((candidate) => ({
    candidate,
    ident: candidate.registration,
    identType: 'registration',
  }))
}

function buildDiscoveryUrl(query, options) {
  const url = new URL(`${API_ROOT}/flights/${encodeURIComponent(query.ident)}`)
  url.searchParams.set('ident_type', query.identType)
  url.searchParams.set('start', options.start)
  url.searchParams.set('end', options.end)
  url.searchParams.set('max_pages', '1')
  return url
}

function buildTrackUrl(faFlightId) {
  const url = new URL(`${API_ROOT}/flights/${encodeURIComponent(faFlightId)}/track`)
  url.searchParams.set('include_estimated_positions', 'false')
  url.searchParams.set('include_surface_positions', 'false')
  return url
}

function monthStartIso(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

async function readApiKey() {
  if (process.env.FLIGHTAWARE_API_KEY?.trim()) return process.env.FLIGHTAWARE_API_KEY.trim()
  throw new Error('Set FLIGHTAWARE_API_KEY for this process; the importer never stores API keys')
}

class AeroApiError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = 'AeroApiError'
    this.status = status
    this.body = body
  }
}

async function requestJson(url, apiKey) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'x-apikey': apiKey,
    },
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { detail: text.slice(0, 500) }
  }
  if (!response.ok) {
    const detail = body?.detail || body?.title || `HTTP ${response.status}`
    throw new AeroApiError(`${url.pathname} returned ${response.status}: ${detail}`, response.status, body)
  }
  return body
}

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const FLIGHT_TIME_FIELDS = [
  'scheduled_out', 'estimated_out', 'actual_out',
  'scheduled_off', 'estimated_off', 'actual_off',
  'scheduled_on', 'estimated_on', 'actual_on',
  'scheduled_in', 'estimated_in', 'actual_in',
  'first_position_time',
]

function overlapsWindow(flight, startMs, endMs) {
  const times = FLIGHT_TIME_FIELDS.map((field) => parseTimestamp(flight[field])).filter(Number.isFinite)
  if (!times.length) return true
  return Math.min(...times) < endMs && Math.max(...times) >= startMs
}

function flightMatchesCandidate(flight, candidate) {
  const values = [flight.ident, flight.ident_icao, flight.ident_iata, flight.atc_ident, flight.registration]
    .map(normalizeIdentifier)
  return values.includes(normalizeIdentifier(candidate.callsign))
    || values.includes(normalizeIdentifier(candidate.registration))
}

function cleanPositions(positions, options) {
  const startMs = Date.parse(options.start)
  const endMs = Date.parse(options.end)
  const seen = new Set()

  return (Array.isArray(positions) ? positions : [])
    .filter((position) => position && position.update_type !== 'P' && position.update_type !== 'V')
    .map((position) => ({
      timestamp: position.timestamp,
      timestampMs: parseTimestamp(position.timestamp),
      latitude: Number(position.latitude),
      longitude: Number(position.longitude),
      altitudeHundredsFt: Number.isFinite(Number(position.altitude)) ? Number(position.altitude) : null,
      altitudeFt: Number.isFinite(Number(position.altitude)) ? Number(position.altitude) * 100 : null,
      groundspeedKt: Number.isFinite(Number(position.groundspeed)) ? Number(position.groundspeed) : null,
      headingDeg: Number.isFinite(Number(position.heading)) ? Number(position.heading) : null,
      altitudeChange: position.altitude_change ?? null,
      updateType: position.update_type ?? null,
    }))
    .filter((position) => Number.isFinite(position.timestampMs)
      && position.timestampMs >= startMs
      && position.timestampMs < endMs
      && Number.isFinite(position.latitude)
      && Number.isFinite(position.longitude))
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .filter((position) => {
      const key = `${position.timestampMs}:${position.latitude}:${position.longitude}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
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
    const midpoint = bucket + FIVE_MINUTES_MS / 2
    const current = buckets.get(bucket)
    if (!current || Math.abs(position.timestampMs - midpoint) < Math.abs(current.timestampMs - midpoint)) {
      buckets.set(bucket, position)
    }
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([bucket, position]) => ({ ...position, bucket: new Date(bucket).toISOString() }))
}

function splitSegments(positions) {
  const segments = []
  let current = []
  for (const position of positions) {
    const previous = current.at(-1)
    if (previous && position.timestampMs - previous.timestampMs > SEGMENT_GAP_MS) {
      if (current.length >= 2) segments.push(current)
      current = []
    }
    current.push(position)
  }
  if (current.length >= 2) segments.push(current)
  return segments
}

function csvCell(value) {
  if (value == null) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function observationsCsv(flights) {
  const headers = [
    'fa_flight_id', 'callsign', 'registration', 'icao24', 'five_minute_bucket_utc',
    'observed_at_utc', 'latitude', 'longitude', 'altitude_ft', 'groundspeed_kt',
    'heading_deg', 'update_type', 'inside_search_area', 'mission_status', 'source',
  ]
  const rows = [headers]
  for (const flight of flights) {
    for (const position of flight.fiveMinutePositions) {
      rows.push([
        flight.faFlightId,
        flight.callsign,
        flight.registration,
        flight.icao24,
        position.bucket,
        position.timestamp,
        position.latitude,
        position.longitude,
        position.altitudeFt,
        position.groundspeedKt,
        position.headingDeg,
        position.updateType,
        position.insideSearchArea,
        'unconfirmed',
        'FlightAware AeroAPI',
      ])
    }
  }
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`
}

function segmentsGeoJson(flights) {
  return {
    type: 'FeatureCollection',
    name: 'FlightAware observed track segments (mission association unconfirmed)',
    features: flights.flatMap((flight) => flight.segments.map((segment, index) => ({
      type: 'Feature',
      properties: {
        callsign: flight.callsign,
        registration: flight.registration,
        icao24: flight.icao24,
        fa_flight_id: flight.faFlightId,
        segment: index + 1,
        observed_start: segment[0].timestamp,
        observed_end: segment.at(-1).timestamp,
        observation_count: segment.length,
        coordinateTimes: segment.map((position) => position.timestamp),
        update_types: [...new Set(segment.map((position) => position.updateType).filter(Boolean))],
        source: 'FlightAware AeroAPI',
        mission_status: 'unconfirmed',
      },
      geometry: {
        type: 'LineString',
        coordinates: segment.map((position) => [position.longitude, position.latitude]),
      },
    }))),
  }
}

function publicFlightSummary(flight, candidate, positions, bounds) {
  const callsign = flight.atc_ident || flight.ident_icao || flight.ident || candidate.callsign
  const registration = flight.registration || candidate.registration
  const inBounds = positions.filter((position) => insideBounds(position, bounds))
  const fiveMinutePositions = sampleFiveMinutes(positions)
    .map((position) => ({ ...position, insideSearchArea: insideBounds(position, bounds) }))
  const updateTypeCounts = positions.reduce((counts, position) => {
    const key = position.updateType || 'unknown'
    counts[key] = (counts[key] || 0) + 1
    return counts
  }, {})

  return {
    faFlightId: flight.fa_flight_id,
    callsign,
    registration,
    icao24: candidate.icao24,
    candidate: candidate.label,
    aircraftType: flight.aircraft_type ?? null,
    origin: flight.origin?.code_icao || flight.origin?.code || null,
    destination: flight.destination?.code_icao || flight.destination?.code || null,
    actualOff: flight.actual_off ?? null,
    actualOn: flight.actual_on ?? null,
    firstObservedAt: positions[0]?.timestamp ?? null,
    lastObservedAt: positions.at(-1)?.timestamp ?? null,
    observationCount: positions.length,
    fiveMinuteObservationCount: fiveMinutePositions.length,
    searchAreaObservationCount: inBounds.length,
    updateTypeCounts,
    missionStatus: 'unconfirmed',
    fiveMinutePositions,
    segments: splitSegments(positions),
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

  const queries = querySpecs()
  const estimatedMaximumCost = queries.length * DISCOVERY_COST_USD + MAX_TRACK_REQUESTS * TRACK_COST_USD
  if (estimatedMaximumCost > MAX_RUN_COST_USD) throw new Error('Internal request cap exceeds the configured run budget')

  if (options.dryRun) {
    stdout.write(`${JSON.stringify({
      source: PROVIDER_URL,
      window: { start: options.start, end: options.end },
      queries: queries.map((query) => ({ candidate: query.candidate.label, url: buildDiscoveryUrl(query, options).toString() })),
      maximumTrackRequests: MAX_TRACK_REQUESTS,
      estimatedMaximumCostUsd: estimatedMaximumCost,
      freeAllowanceUsd: FREE_ALLOWANCE_USD,
      output: path.resolve(options.output),
    }, null, 2)}\n`)
    return
  }

  const apiKey = await readApiKey()
  const outputDir = path.resolve(options.output)
  const rawDir = path.join(outputDir, 'raw')
  await mkdir(rawDir, { recursive: true })

  const usageUrl = new URL(`${API_ROOT}/account/usage`)
  usageUrl.searchParams.set('start', monthStartIso())
  usageUrl.searchParams.set('all_keys', 'true')
  const usageBefore = await requestJson(usageUrl, apiKey)
  const recordedMonthlyCost = Number(usageBefore?.total_cost || 0)
  if (recordedMonthlyCost + estimatedMaximumCost > FREE_ALLOWANCE_USD) {
    throw new Error(`Aborting before paid calls: recorded monthly usage ($${recordedMonthlyCost.toFixed(3)}) plus the $${estimatedMaximumCost.toFixed(3)} run cap could exceed the $${FREE_ALLOWANCE_USD.toFixed(2)} free allowance`)
  }

  const discovery = []
  const discoveryErrors = []
  const discoveredFlights = new Map()
  for (const query of queries) {
    const url = buildDiscoveryUrl(query, options)
    process.stderr.write(`Discovering ${query.candidate.label} via ${query.identType} ${query.ident}\n`)
    let body
    try {
      body = await requestJson(url, apiKey)
    } catch (error) {
      if (!(error instanceof AeroApiError)) throw error
      discoveryErrors.push({
        candidate: query.candidate.label,
        ident: query.ident,
        identType: query.identType,
        status: error.status,
        detail: error.message,
      })
      await writeJson(path.join(rawDir, `discovery-error-${normalizeIdentifier(query.ident)}-${query.identType}.json`), error.body)
      continue
    }
    const rawName = `discovery-${normalizeIdentifier(query.ident)}-${query.identType}.json`
    await writeJson(path.join(rawDir, rawName), body)

    const returned = Array.isArray(body?.flights) ? body.flights : []
    const matching = returned.filter((flight) => flightMatchesCandidate(flight, query.candidate))
    discovery.push({
      candidate: query.candidate.label,
      ident: query.ident,
      identType: query.identType,
      returnedFlights: returned.length,
      matchingFlights: matching.length,
      numPages: body?.num_pages ?? 1,
    })

    for (const flight of matching) {
      if (!flight.fa_flight_id || !overlapsWindow(flight, Date.parse(options.start), Date.parse(options.end))) continue
      const current = discoveredFlights.get(flight.fa_flight_id)
      discoveredFlights.set(flight.fa_flight_id, current || { flight, candidate: query.candidate })
    }
  }

  const candidatesToFetch = [...discoveredFlights.values()]
  if (candidatesToFetch.length > MAX_TRACK_REQUESTS) {
    throw new Error(`Found ${candidatesToFetch.length} matching flight IDs; refusing to exceed the ${MAX_TRACK_REQUESTS}-track safety cap`)
  }

  const flights = []
  const trackErrors = []
  for (const { flight, candidate } of candidatesToFetch) {
    process.stderr.write(`Fetching observed track for ${candidate.label} (${flight.fa_flight_id})\n`)
    try {
      const body = await requestJson(buildTrackUrl(flight.fa_flight_id), apiKey)
      await writeJson(path.join(rawDir, `track-${normalizeIdentifier(flight.fa_flight_id)}.json`), body)
      const positions = cleanPositions(body?.positions, options)
      flights.push(publicFlightSummary(flight, candidate, positions, options.bounds))
    } catch (error) {
      if (!(error instanceof AeroApiError)) throw error
      trackErrors.push({
        candidate: candidate.label,
        faFlightId: flight.fa_flight_id,
        status: error.status,
        detail: error.message,
      })
    }
  }

  const retrievedAt = new Date().toISOString()
  const deleteRawAfter = new Date(Date.now() + RAW_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const requestCostUpperBound = queries.length * DISCOVERY_COST_USD
    + candidatesToFetch.length * TRACK_COST_USD
  const manifest = {
    schemaVersion: 1,
    source: {
      provider: 'FlightAware AeroAPI',
      url: PROVIDER_URL,
      endpoints: ['/flights/{ident}', '/flights/{fa_flight_id}/track'],
      includeEstimatedPositions: false,
      includeSurfacePositions: false,
    },
    retrievedAt,
    rawDeleteAfter: deleteRawAfter,
    window: { start: options.start, end: options.end },
    searchBounds: options.bounds,
    budget: {
      freeAllowanceUsd: FREE_ALLOWANCE_USD,
      recordedMonthlyCostBeforeRunUsd: recordedMonthlyCost,
      maximumCostForThisRunUsd: estimatedMaximumCost,
      actualRequestCostUpperBoundUsd: requestCostUpperBound,
      discoveryRequests: queries.length,
      trackRequests: candidatesToFetch.length,
    },
    discovery,
    discoveryErrors,
    trackErrors,
    flights: flights.map(({ fiveMinutePositions, segments, ...flight }) => flight),
    interpretation: [
      'Every exported coordinate is an AeroAPI observation; no position was interpolated.',
      'The 5-minute CSV selects one real observation nearest each UTC five-minute bucket midpoint. Empty buckets remain empty.',
      'LineStrings are split whenever observations are more than 10 minutes apart, so coverage gaps are not joined.',
      'Presence inside the broad search area does not prove participation in the firefighting mission.',
      'G10 and G12 remain candidate identifiers until an official or independent source confirms the mission assignment.',
    ],
  }

  await writeJson(path.join(outputDir, 'manifest.json'), manifest)
  await writeJson(path.join(outputDir, 'track-segments.geojson'), segmentsGeoJson(flights))
  await writeFile(path.join(outputDir, 'observations-5m.csv'), observationsCsv(flights), 'utf8')

  stdout.write(`${JSON.stringify({
    output: outputDir,
    discoveredFlightIds: candidatesToFetch.length,
    tracksRetrieved: flights.length,
    totalObservedPositions: flights.reduce((sum, flight) => sum + flight.observationCount, 0),
    fiveMinuteObservations: flights.reduce((sum, flight) => sum + flight.fiveMinuteObservationCount, 0),
    observationsInsideSearchArea: flights.reduce((sum, flight) => sum + flight.searchAreaObservationCount, 0),
    trackErrors,
    maximumRunCostUsd: estimatedMaximumCost,
    actualRequestCostUpperBoundUsd: requestCostUpperBound,
    recordedMonthlyCostBeforeRunUsd: recordedMonthlyCost,
    rawDeleteAfter: deleteRawAfter,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
