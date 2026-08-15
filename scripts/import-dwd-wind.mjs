#!/usr/bin/env node

// Imports every DWD ten-minute wind station within 40 km of Drossart. Recent
// and hourly-updated archives are both retained: the former supplies history,
// while the latter supplies the current UTC day. DWD documents both feeds as
// not yet having completed final quality control.

import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DWD_ROOT = 'https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes/wind'
const SOURCE_DOC = `${DWD_ROOT}/DESCRIPTION_obsgermany_climate_10min_wind_en.pdf`
const DROSSART = { latitude: 50.54762, longitude: 6.05757 }
const RADIUS_KM = 40

// Derived from the official zehn_now_ff_Beschreibung_Stationen.txt catalogue.
const STATIONS = [
  { id: '15000', name: 'Aachen-Orsbach', latitude: 50.7983, longitude: 6.0244, altitudeM: 231, distanceKm: 27.9722 },
  { id: '02497', name: 'Kall-Sistig', latitude: 50.5014, longitude: 6.5264, altitudeM: 505, distanceKm: 33.5386 },
  { id: '04279', name: 'Roth bei Prüm', latitude: 50.3046, longitude: 6.3863, altitudeM: 593, distanceKm: 35.6722 },
]

const DEFAULTS = {
  start: '2026-08-14T11:00:00Z',
  end: '',
  output: '',
  snapshot: 'src/dwdWindObservations.json',
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, dryRun: false, writeSnapshot: false }
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') continue
    if (token === '--dry-run') { options.dryRun = true; continue }
    if (token === '--write-snapshot') { options.writeSnapshot = true; continue }
    const key = token.replace(/^--/, '')
    const value = argv[index + 1]
    if (!(key in options) || value == null) throw new Error(`Unknown or incomplete argument: ${token}`)
    options[key] = value
    index += 1
  }
  if (!options.end) options.end = new Date().toISOString()
  if (!options.output) options.output = `.local-data/dwd/${options.start.slice(0, 10)}`
  return options
}

function archiveRequests() {
  return STATIONS.flatMap((station) => [
    {
      station,
      kind: 'recent',
      url: `${DWD_ROOT}/recent/10minutenwerte_wind_${station.id}_akt.zip`,
    },
    {
      station,
      kind: 'now',
      url: `${DWD_ROOT}/now/10minutenwerte_wind_${station.id}_now.zip`,
    },
  ])
}

function timestampFromDwd(raw) {
  const value = String(raw).trim()
  if (!/^\d{12}$/.test(value)) return null
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:00Z`
}

function finiteMeasurement(raw) {
  const value = Number(String(raw).trim())
  return Number.isFinite(value) && value > -900 ? value : null
}

function parseArchive(text, station, archiveKind, startMs, endMs) {
  const lines = text.trim().split(/\r?\n/)
  const headers = (lines.shift() || '').split(';').map((value) => value.trim())
  const index = Object.fromEntries(headers.map((header, position) => [header, position]))
  for (const required of ['STATIONS_ID', 'MESS_DATUM', 'QN', 'FF_10', 'DD_10']) {
    if (index[required] == null) throw new Error(`${station.name} ${archiveKind}: missing ${required}`)
  }

  return lines.flatMap((line) => {
    const cells = line.split(';')
    const observedAt = timestampFromDwd(cells[index.MESS_DATUM])
    const timestampMs = Date.parse(observedAt)
    if (!observedAt || timestampMs < startMs || timestampMs > endMs) return []
    const windSpeedMs = finiteMeasurement(cells[index.FF_10])
    const windDirection = finiteMeasurement(cells[index.DD_10])
    if (windSpeedMs == null || windDirection == null) return []

    return [{
      stationId: station.id,
      observedAt,
      windSpeedMs,
      windSpeedKmh: windSpeedMs * 3.6,
      windDirection,
      qualityLevel: finiteMeasurement(cells[index.QN]),
      archiveKind,
    }]
  })
}

async function main() {
  const options = parseArgs(process.argv)
  const requests = archiveRequests()
  if (options.dryRun) {
    console.log(`Planned ${requests.length} official DWD archive request(s), no network access:`)
    requests.forEach((request) => console.log(`  ${request.station.name.padEnd(17)} ${request.kind.padEnd(6)} ${request.url}`))
    console.log(`\nSelection: all DWD ten-minute wind stations within ${RADIUS_KM} km of Drossart.`)
    console.log(`Snapshot ${options.writeSnapshot ? 'WOULD' : 'would NOT'} be replaced (${options.snapshot}).`)
    return
  }

  const outputDir = path.resolve(options.output)
  const rawDir = path.join(outputDir, 'raw')
  await mkdir(rawDir, { recursive: true })
  const startMs = Date.parse(options.start)
  const endMs = Date.parse(options.end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    throw new Error('Invalid --start/--end window')
  }

  const observations = new Map()
  const sources = []
  for (const request of requests) {
    process.stderr.write(`Fetching ${request.station.name} ${request.kind}\n`)
    const response = await fetch(request.url, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`${request.station.name} ${request.kind}: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const archivePath = path.join(rawDir, `${request.station.id}-${request.kind}.zip`)
    await writeFile(archivePath, bytes)
    const { stdout } = await execFileAsync('unzip', ['-p', archivePath], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    parseArchive(stdout, request.station, request.kind, startMs, endMs).forEach((observation) => {
      observations.set(`${observation.stationId}|${observation.observedAt}`, observation)
    })
    sources.push({ stationId: request.station.id, archiveKind: request.kind, url: request.url })
  }

  const normalized = [...observations.values()].sort((left, right) => (
    Date.parse(left.observedAt) - Date.parse(right.observedAt)
    || left.stationId.localeCompare(right.stationId)
  ))
  const generatedAt = new Date().toISOString()
  const snapshot = {
    schemaVersion: 1,
    generatedAt,
    source: {
      name: 'Deutscher Wetterdienst Climate Data Center',
      url: DWD_ROOT,
      documentationUrl: SOURCE_DOC,
      stationCatalogueUrl: `${DWD_ROOT}/now/zehn_now_ff_Beschreibung_Stationen.txt`,
    },
    locationReference: { ...DROSSART, name: 'Drossart locality' },
    selection: { radiusKm: RADIUS_KM, stationCount: STATIONS.length },
    cadenceMinutes: 10,
    qualityStatus: 'preliminary',
    stations: STATIONS,
    sources,
    window: { start: options.start, end: options.end },
    observations: normalized,
    interpretation: [
      `All DWD ten-minute wind stations within ${RADIUS_KM} km of Drossart are included.`,
      'FF_10 is the ten-minute mean wind speed in m/s; DD_10 is wind direction in degrees.',
      'Timestamps are UTC. Coordinates, values and DWD quality-level codes are retained without interpolation.',
      'DWD documents the recent and now feeds as not having completed final quality control.',
      'Station conditions tens of kilometres away must not be treated as measurements at the fire front.',
    ],
  }

  await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  await writeFile(path.join(outputDir, 'observations.json'), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  console.log(`\nRetained ${normalized.length} observations from ${STATIONS.length} DWD stations.`)
  for (const station of STATIONS) {
    const count = normalized.filter((observation) => observation.stationId === station.id).length
    console.log(`  ${station.name.padEnd(17)} ${String(count).padStart(3)} rows · ${station.distanceKm.toFixed(1)} km from Drossart`)
  }

  if (!options.writeSnapshot) {
    console.log('\nBundled snapshot left untouched. Re-run with --write-snapshot to replace it.')
    return
  }
  await writeFile(path.resolve(options.snapshot), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  console.log(`Wrote ${options.snapshot}`)
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exitCode = 1
})
