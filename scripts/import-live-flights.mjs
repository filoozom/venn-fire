#!/usr/bin/env node

import { rename, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gzip as gzipCallback } from 'node:zlib'

import {
  INCIDENT,
  INCIDENT_AIRCRAFT,
  INCIDENT_RADIUS_KM,
  LIVE_AIRCRAFT_PROVIDERS,
  loadAircraft,
} from '../api/live-situation.js'

const gzip = promisify(gzipCallback)
export const FLIGHT_IMPORT_INTERVAL_MINUTES = 5

const DEFAULTS = {
  output: '.local-data/live-flights',
  retentionDays: 30,
  adsbFiUrl: '',
  adsbLolUrl: '',
  dryRun: false,
  help: false,
}

function parseArgs(argv) {
  const options = { ...DEFAULTS }
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (argument === '--dry-run') { options.dryRun = true; continue }
    if (argument === '--help' || argument === '-h') { options.help = true; continue }

    const key = argument.replace(/^--/, '')
    const value = argv[index + 1]
    if (!argument.startsWith('--') || !(key in options) || value == null) {
      throw new Error(`Unknown or incomplete argument: ${argument}`)
    }
    options[key] = key === 'retentionDays' ? Number(value) : value
    index += 1
  }

  if (!Number.isFinite(options.retentionDays) || options.retentionDays <= 0) {
    throw new Error('--retentionDays must be a positive number')
  }
  return options
}

function printHelp() {
  process.stdout.write(`Incremental live-flight importer\n\n`)
  process.stdout.write(`Usage: pnpm import:live-flights -- [options]\n\n`)
  process.stdout.write(`  --output <path>       Audit output directory (${DEFAULTS.output})\n`)
  process.stdout.write(`  --retentionDays <n>   Normalized observation retention (${DEFAULTS.retentionDays})\n`)
  process.stdout.write(`  --adsbFiUrl <url>     Override the adsb.fi endpoint (testing/failover)\n`)
  process.stdout.write(`  --adsbLolUrl <url>    Override the ADSB.lol endpoint (testing/failover)\n`)
  process.stdout.write(`  --dry-run             Print the import plan without fetching or writing\n`)
  process.stdout.write(`  --help                Show this help\n`)
}

function providersFor(options) {
  return LIVE_AIRCRAFT_PROVIDERS.map((provider) => {
    if (provider.id === 'adsb-fi' && options.adsbFiUrl) return { ...provider, endpoint: options.adsbFiUrl }
    if (provider.id === 'adsb-lol' && options.adsbLolUrl) return { ...provider, endpoint: options.adsbLolUrl }
    return provider
  })
}

function observationKey(observation) {
  return [
    String(observation.icao24 || '').toLowerCase(),
    observation.observedAt,
    observation.latitude,
    observation.longitude,
  ].join('|')
}

function validateObservation(observation) {
  return observation
    && INCIDENT_AIRCRAFT.has(String(observation.icao24 || '').toLowerCase())
    && Number.isFinite(Date.parse(observation.observedAt))
    && Number.isFinite(Number(observation.latitude))
    && Number.isFinite(Number(observation.longitude))
    && Number(observation.distanceDrossartKm) <= INCIDENT_RADIUS_KM
}

function mergeDuplicate(existing, incoming) {
  const providerIds = new Set([
    existing.providerId,
    ...(existing.corroboratedBy || []),
    incoming.providerId,
    ...(incoming.corroboratedBy || []),
  ].filter(Boolean))
  providerIds.delete(existing.providerId)
  return { ...existing, corroboratedBy: [...providerIds].sort() }
}

export function mergeObservations(existing, incoming, requestedAtMs, retentionDays) {
  const cutoffMs = requestedAtMs - retentionDays * 24 * 60 * 60 * 1_000
  const mergedByKey = new Map()

  for (const observation of existing) {
    if (!validateObservation(observation) || Date.parse(observation.observedAt) < cutoffMs) continue
    mergedByKey.set(observationKey(observation), observation)
  }

  const existingKeys = new Set(mergedByKey.keys())
  for (const observation of incoming) {
    if (!validateObservation(observation) || Date.parse(observation.observedAt) < cutoffMs) continue
    const key = observationKey(observation)
    const previous = mergedByKey.get(key)
    mergedByKey.set(key, previous ? mergeDuplicate(previous, observation) : observation)
  }

  const observations = [...mergedByKey.values()].sort((left, right) => (
    Date.parse(left.observedAt) - Date.parse(right.observedAt)
      || left.icao24.localeCompare(right.icao24)
  ))
  const importedCount = [...mergedByKey.keys()].filter((key) => !existingKeys.has(key)).length
  return {
    observations,
    importedCount,
    duplicateCount: incoming.length - importedCount,
    expiredCount: existing.length - [...existingKeys].length,
  }
}

async function readExistingSnapshot(filePath) {
  try {
    const snapshot = JSON.parse(await readFile(filePath, 'utf8'))
    if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.observations)) {
      throw new Error(`${filePath} does not contain a supported live-flight snapshot`)
    }
    return snapshot.observations
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function writeAtomically(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  await writeFile(temporaryPath, contents)
  await rename(temporaryPath, filePath)
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function csvCell(value) {
  if (value == null) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function observationsCsv(observations) {
  const rows = [[
    'icao24', 'callsign', 'registration', 'observed_at_utc', 'latitude', 'longitude',
    'altitude_ft', 'groundspeed_kt', 'track_degrees', 'distance_drossart_km',
    'provider', 'corroborated_by', 'mission_status',
  ]]
  for (const observation of observations) {
    rows.push([
      observation.icao24,
      observation.callSign,
      observation.registration,
      observation.observedAt,
      observation.latitude,
      observation.longitude,
      observation.altitudeFt,
      observation.groundSpeedKt,
      observation.trackDegrees,
      observation.distanceDrossartKm,
      observation.providerName,
      (observation.corroboratedBy || []).join(';'),
      'unconfirmed',
    ])
  }
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`
}

function observationsGeoJson(observations, generatedAt) {
  return {
    type: 'FeatureCollection',
    name: 'Five-minute live incident-aircraft imports (exact receiver observations)',
    generatedAt,
    features: observations.map((observation) => ({
      type: 'Feature',
      properties: {
        icao24: observation.icao24,
        callsign: observation.callSign,
        registration: observation.registration,
        observed_at: observation.observedAt,
        altitude_ft: observation.altitudeFt,
        groundspeed_kt: observation.groundSpeedKt,
        track_degrees: observation.trackDegrees,
        distance_drossart_km: observation.distanceDrossartKm,
        provider: observation.providerName,
        provider_url: observation.providerUrl,
        corroborated_by: observation.corroboratedBy || [],
        update_type: observation.updateType,
        mission_status: 'unconfirmed',
      },
      geometry: {
        type: 'Point',
        coordinates: [observation.longitude, observation.latitude],
      },
    })),
  }
}

function rawTimestamp(isoTimestamp) {
  return isoTimestamp.replaceAll('-', '').replaceAll(':', '').replaceAll('.', '')
}

export async function importLiveFlights(options, load = loadAircraft, requestedAtMs = Date.now()) {
  const providers = providersFor(options)
  const outputDir = path.resolve(options.output)
  const rawDir = path.join(outputDir, 'raw')
  const observationsPath = path.join(outputDir, 'observations.json')
  await mkdir(rawDir, { recursive: true })

  const requestedAt = new Date(requestedAtMs).toISOString()
  const result = await load(requestedAtMs, providers, { includeRaw: true })
  const existing = await readExistingSnapshot(observationsPath)
  const merged = mergeObservations(existing, result.observations, requestedAtMs, options.retentionDays)

  const rawFiles = []
  for (const response of result.rawResponses || []) {
    const rawName = `${rawTimestamp(requestedAt)}-${response.provider.id}.json.gz`
    const rawBody = response.rawBody ?? JSON.stringify(response.payload)
    await writeFile(path.join(rawDir, rawName), await gzip(rawBody))
    rawFiles.push(path.posix.join('raw', rawName))
  }

  const snapshot = {
    schemaVersion: 1,
    generatedAt: requestedAt,
    importIntervalMinutes: FLIGHT_IMPORT_INTERVAL_MINUTES,
    retentionDays: options.retentionDays,
    incident: {
      latitude: INCIDENT.latitude,
      longitude: INCIDENT.longitude,
      radiusKm: INCIDENT_RADIUS_KM,
    },
    observationCount: merged.observations.length,
    observations: merged.observations,
  }
  const manifest = {
    schemaVersion: 1,
    retrievedAt: requestedAt,
    source: providers.map(({ id, name, website, endpoint }) => ({ id, name, website, endpoint })),
    cadence: {
      intervalMinutes: FLIGHT_IMPORT_INTERVAL_MINUTES,
      scheduler: 'scripts/refresh-daemon.mjs',
    },
    selection: {
      incident: INCIDENT,
      radiusKm: INCIDENT_RADIUS_KM,
      aircraft: [...INCIDENT_AIRCRAFT.entries()].map(([icao24, identity]) => ({ icao24, ...identity })),
    },
    poll: {
      sources: result.sources,
      conflicts: result.conflicts,
      receivedObservations: result.observations.length,
      importedObservations: merged.importedCount,
      duplicateObservations: merged.duplicateCount,
      expiredObservations: merged.expiredCount,
      retainedObservations: merged.observations.length,
      rawFiles,
    },
    interpretation: [
      'Every coordinate is an exact live receiver observation; positions are never interpolated or averaged.',
      'Only evidence-backed incident-aircraft identifiers observed within 10 km of Drossart are retained.',
      'Absence from an import is not proof that an aircraft did not fly.',
      'Provider responses are compressed exactly as received beneath raw/.',
    ],
  }

  await writeAtomically(observationsPath, json(snapshot))
  await writeAtomically(path.join(outputDir, 'observations.geojson'), json(observationsGeoJson(merged.observations, requestedAt)))
  await writeAtomically(path.join(outputDir, 'observations.csv'), observationsCsv(merged.observations))
  await writeAtomically(path.join(outputDir, 'manifest.json'), json(manifest))

  return {
    output: outputDir,
    receivedObservations: result.observations.length,
    importedObservations: merged.importedCount,
    duplicateObservations: merged.duplicateCount,
    retainedObservations: merged.observations.length,
    healthySources: result.sources.filter((source) => source.ok).map((source) => source.id),
  }
}

export async function main(argv = process.argv) {
  const options = parseArgs(argv)
  if (options.help) {
    printHelp()
    return
  }
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({
      intervalMinutes: FLIGHT_IMPORT_INTERVAL_MINUTES,
      output: path.resolve(options.output),
      retentionDays: options.retentionDays,
      providers: providersFor(options).map(({ id, name, endpoint }) => ({ id, name, endpoint })),
    })}\n`)
    return
  }

  const summary = await importLiveFlights(options)
  process.stdout.write(`${JSON.stringify(summary)}\n`)
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`)
    process.exitCode = 1
  })
}
