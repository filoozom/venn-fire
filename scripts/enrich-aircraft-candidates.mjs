#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const INCIDENT_START = '2026-08-14T11:06:00.000Z'
const MAX_CANDIDATE_ALTITUDE_FT = 5000
const REQUEST_DELAY_MS = 1100
const DROSSART = { latitude: 50.54762, longitude: 6.05757 }
const DEFAULTS = {
  date: '2026-08-14',
  sourceRoot: 'https://globe.airplanes.live/globe_history',
  input: '.local-data/airplanes-live/2026-08-14/area-scan.json',
  output: '.local-data/airplanes-live/2026-08-14/low-altitude-candidates.json',
}

function parseArgs(argv) {
  const options = { ...DEFAULTS }
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--') continue
    const key = argv[index].replace(/^--/, '')
    const value = argv[index + 1]
    if (!(key in options) || value == null) throw new Error(`Unknown or incomplete argument: ${argv[index]}`)
    options[key] = value
    index += 1
  }
  return options
}

function traceUrl(sourceRoot, date, icao24) {
  return `${sourceRoot.replace(/\/$/, '')}/${date.replaceAll('-', '/')}/traces/${icao24.slice(-2)}/trace_full_${icao24}.json`
}

function haversineKm(position) {
  const radians = Math.PI / 180
  const deltaLat = (position.lat - DROSSART.latitude) * radians
  const deltaLon = (position.lon - DROSSART.longitude) * radians
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(DROSSART.latitude * radians) * Math.cos(position.lat * radians) * Math.sin(deltaLon / 2) ** 2
  return 6371.0088 * 2 * Math.asin(Math.sqrt(value))
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function main() {
  const options = parseArgs(process.argv)
  const inputPath = path.resolve(options.input)
  const outputPath = path.resolve(options.output)
  const rawDir = path.join(path.dirname(outputPath), 'raw')
  const scan = JSON.parse(await readFile(inputPath, 'utf8'))
  await mkdir(rawDir, { recursive: true })

  const candidates = scan.aircraft.filter((aircraft) => (
    aircraft.minAltitude != null
    && aircraft.minAltitude <= MAX_CANDIDATE_ALTITUDE_FT
    && aircraft.last >= INCIDENT_START
  ))
  const results = []

  for (const [index, candidate] of candidates.entries()) {
    const url = traceUrl(options.sourceRoot, options.date, candidate.hex)
    const rawPath = path.join(rawDir, `candidate-trace-${candidate.hex}.json`)
    let body
    let retrievalMode = 'network'
    let retrievalWarning = null
    process.stderr.write(`Fetching candidate ${candidate.callsign || candidate.hex} (${candidate.hex})\n`)

    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      body = await response.json()
      await writeJson(rawPath, body)
    } catch (networkError) {
      try {
        body = JSON.parse(await readFile(rawPath, 'utf8'))
        retrievalMode = 'local-cache'
        retrievalWarning = `Network retrieval failed; used saved response (${networkError.message})`
      } catch {
        retrievalMode = 'failed'
        retrievalWarning = networkError.message
      }
    }

    const observations = scan.observations.filter((observation) => (
      observation.hex === candidate.hex && observation.observedAt >= INCIDENT_START
    ))
    const distances = observations.map(haversineKm)
    results.push({
      ...candidate,
      sourceRegistration: body?.r ?? null,
      aircraftType: body?.t ?? null,
      description: body?.desc ?? null,
      databaseFlags: body?.dbFlags ?? null,
      nearestDrossartObservationKm: distances.length ? Math.min(...distances) : null,
      observationsWithin2KmOfDrossart: distances.filter((distance) => distance <= 2).length,
      observationsWithin5KmOfDrossart: distances.filter((distance) => distance <= 5).length,
      incidentWindowObservationCount: observations.length,
      retrievalMode,
      sourceResponseSavedAt: body ? (await stat(rawPath)).mtime.toISOString() : null,
      retrievalWarning,
      traceUrl: url,
      missionStatus: 'unconfirmed',
    })

    if (index < candidates.length - 1) await delay(REQUEST_DELAY_MS)
  }

  const result = {
    schemaVersion: 1,
    source: options.sourceRoot,
    areaScan: inputPath,
    normalizedAt: new Date().toISOString(),
    incidentStart: INCIDENT_START,
    locationReference: {
      name: 'Drossart locality (OpenStreetMap node 5770188072)',
      ...DROSSART,
      url: 'https://www.openstreetmap.org/node/5770188072',
    },
    selection: `Every area-scan aircraft observed at or below ${MAX_CANDIDATE_ALTITUDE_FT} ft after the reported incident start`,
    candidates: results.sort((left, right) => (
      (left.nearestDrossartObservationKm ?? Number.POSITIVE_INFINITY)
      - (right.nearestDrossartObservationKm ?? Number.POSITIVE_INFINITY)
    )),
    interpretation: [
      'Selection by altitude and proximity is for investigation only; it does not establish an incident role.',
      'Aircraft metadata comes from the source replay trace and may be incomplete or crowdsourced.',
      'Receiver coverage is incomplete, especially for low-level Mode S aircraft.',
    ],
  }

  await writeJson(outputPath, result)
  process.stdout.write(`${JSON.stringify({ output: outputPath, candidates: result.candidates }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
