#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULTS = {
  airplanesLiveScan: '.local-data/airplanes-live/2026-08-14/area-scan.json',
  airplanesLiveCandidates: '.local-data/airplanes-live/2026-08-14/low-altitude-candidates.json',
  adsbLolScan: '.local-data/adsb-lol/2026-08-14/area-scan.json',
  adsbLolCandidates: '.local-data/adsb-lol/2026-08-14/low-altitude-candidates.json',
  output: 'src/nearbyTrafficSnapshot.json',
  summaryOutput: 'src/nearbyTrafficSummary.json',
  selectionRadiusKm: 5,
  contextRadiusKm: 10,
}

const DROSSART = {
  name: 'Drossart locality (OpenStreetMap node 5770188072)',
  latitude: 50.54762,
  longitude: 6.05757,
  url: 'https://www.openstreetmap.org/node/5770188072',
}

const EXCLUDED_INCIDENT_AIRCRAFT = new Set(['44c1e5'])

function parseArgs(argv) {
  const options = { ...DEFAULTS }
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--') continue
    const key = argv[index].replace(/^--/, '')
    const value = argv[index + 1]
    if (!(key in options) || value == null) throw new Error(`Unknown or incomplete argument: ${argv[index]}`)
    options[key] = ['selectionRadiusKm', 'contextRadiusKm'].includes(key) ? Number(value) : value
    index += 1
  }
  if (!(options.selectionRadiusKm > 0) || !(options.contextRadiusKm >= options.selectionRadiusKm)) {
    throw new Error('contextRadiusKm must be greater than or equal to a positive selectionRadiusKm')
  }
  return options
}

function haversineKm(observation) {
  const radians = Math.PI / 180
  const deltaLat = (observation.lat - DROSSART.latitude) * radians
  const deltaLon = (observation.lon - DROSSART.longitude) * radians
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(DROSSART.latitude * radians)
      * Math.cos(observation.lat * radians)
      * Math.sin(deltaLon / 2) ** 2
  return 6371.0088 * 2 * Math.asin(Math.sqrt(value))
}

async function readJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'))
}

function candidateMap(document) {
  return new Map((document.candidates || []).map((candidate) => [candidate.hex, candidate]))
}

function normalizeProvider(id, name, website, scan, candidates) {
  const observationsByHex = new Map()
  for (const observation of scan.observations || []) {
    const distanceKm = haversineKm(observation)
    if (!observationsByHex.has(observation.hex)) observationsByHex.set(observation.hex, [])
    observationsByHex.get(observation.hex).push({ ...observation, distanceKm })
  }
  for (const observations of observationsByHex.values()) {
    observations.sort((left, right) => left.observedAt.localeCompare(right.observedAt))
  }
  return {
    id,
    name,
    website,
    historyRoot: scan.source,
    retrievedAt: scan.retrievedAt,
    scanCadenceSeconds: Math.min(...(scan.observations || []).map((observation) => observation.interval).filter(Number.isFinite)),
    scanBounds: scan.bounds,
    chunks: scan.chunks,
    observationsByHex,
    candidates: candidateMap(candidates),
  }
}

function aircraftMetadata(providers, hex, preferredProvider) {
  const ordered = [preferredProvider, ...providers.filter((provider) => provider !== preferredProvider)]
  for (const provider of ordered) {
    const candidate = provider.candidates.get(hex)
    if (!candidate) continue
    return {
      registration: candidate.sourceRegistration || null,
      aircraftType: candidate.aircraftType || null,
      description: candidate.description || null,
      metadataSource: candidate.sourceRegistration || candidate.aircraftType || candidate.description
        ? provider.name
        : null,
    }
  }
  return { registration: null, aircraftType: null, description: null, metadataSource: null }
}

function selectedHexes(providers, selectionRadiusKm) {
  const result = new Set()
  for (const provider of providers) {
    for (const [hex, observations] of provider.observationsByHex) {
      if (observations.some((observation) => observation.distanceKm <= selectionRadiusKm)) result.add(hex)
    }
  }
  return result
}

function sourceObservation(provider, observation) {
  return {
    observedAt: observation.observedAt,
    latitude: observation.lat,
    longitude: observation.lon,
    altitudeFt: typeof observation.altitude === 'number' ? observation.altitude : null,
    distanceDrossartKm: Number(observation.distanceKm.toFixed(3)),
  }
}

async function main() {
  const options = parseArgs(process.argv)
  const [airplanesLiveScan, airplanesLiveCandidates, adsbLolScan, adsbLolCandidates] = await Promise.all([
    readJson(options.airplanesLiveScan),
    readJson(options.airplanesLiveCandidates),
    readJson(options.adsbLolScan),
    readJson(options.adsbLolCandidates),
  ])
  const providers = [
    normalizeProvider('airplanes-live', 'Airplanes.live', 'https://airplanes.live/', airplanesLiveScan, airplanesLiveCandidates),
    normalizeProvider('adsb-lol', 'ADSB.lol', 'https://adsb.lol/', adsbLolScan, adsbLolCandidates),
  ]
  const ids = [...selectedHexes(providers, options.selectionRadiusKm)]
    .filter((hex) => !EXCLUDED_INCIDENT_AIRCRAFT.has(hex))
    .sort()

  const aircraft = ids.map((hex) => {
    const sourceCoverage = providers.map((provider) => {
      const all = provider.observationsByHex.get(hex) || []
      const context = all.filter((observation) => observation.distanceKm <= options.contextRadiusKm)
      return {
        provider,
        selectedAreaCount: all.filter((observation) => observation.distanceKm <= options.selectionRadiusKm).length,
        context,
      }
    }).filter((coverage) => coverage.selectedAreaCount > 0)

    const chosen = [...sourceCoverage].sort((left, right) => (
      right.context.length - left.context.length
      || providers.indexOf(left.provider) - providers.indexOf(right.provider)
    ))[0]
    const allProviderObservations = sourceCoverage.flatMap((coverage) => coverage.context)
    const metadata = aircraftMetadata(providers, hex, chosen.provider)
    const sourceAircraft = chosen.provider.observationsByHex.get(hex)?.[0]
    const sourceSummary = chosen.context
    const minimumAltitudeFt = Math.min(...allProviderObservations
      .map((observation) => observation.altitude)
      .filter((altitude) => typeof altitude === 'number'))
    const callSign = sourceAircraft?.callsign
      || sourceCoverage.flatMap((coverage) => coverage.context).find((observation) => observation.callsign)?.callsign
      || null

    return {
      id: `traffic-${hex}`,
      icao24: hex,
      callSign,
      ...metadata,
      classification: minimumAltitudeFt <= 5000 ? 'low-level' : 'overflight',
      missionStatus: 'No incident role established',
      geometrySource: chosen.provider.id,
      observedBy: sourceCoverage.map((coverage) => coverage.provider.id),
      providerObservationCounts: Object.fromEntries(sourceCoverage.map((coverage) => [
        coverage.provider.id,
        coverage.context.length,
      ])),
      providerSelectionCounts: Object.fromEntries(sourceCoverage.map((coverage) => [
        coverage.provider.id,
        coverage.selectedAreaCount,
      ])),
      nearestDrossartKm: Number(Math.min(...allProviderObservations.map((observation) => observation.distanceKm)).toFixed(3)),
      observationsWithinSelectionRadius: chosen.selectedAreaCount,
      firstObservedAt: sourceSummary[0]?.observedAt || null,
      lastObservedAt: sourceSummary.at(-1)?.observedAt || null,
      observations: chosen.context.map((observation) => sourceObservation(chosen.provider, observation)),
    }
  }).sort((left, right) => (
    (left.classification === 'low-level' ? 0 : 1) - (right.classification === 'low-level' ? 0 : 1)
    || left.nearestDrossartKm - right.nearestDrossartKm
  ))

  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    incidentDate: '2026-08-14',
    locationReference: DROSSART,
    selection: {
      rule: `Every identifier observed within ${options.selectionRadiusKm} km of Drossart in either retained receiver replay`,
      selectionRadiusKm: options.selectionRadiusKm,
      contextRadiusKm: options.contextRadiusKm,
      excludedIncidentAircraft: [...EXCLUDED_INCIDENT_AIRCRAFT],
    },
    sources: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      website: provider.website,
      historyRoot: provider.historyRoot,
      retrievedAt: provider.retrievedAt,
      scanCadenceSeconds: provider.scanCadenceSeconds,
      chunks: provider.chunks,
      scanBounds: provider.scanBounds,
    })),
    aircraftCount: aircraft.length,
    lowLevelAircraftCount: aircraft.filter((item) => item.classification === 'low-level').length,
    overflightAircraftCount: aircraft.filter((item) => item.classification === 'overflight').length,
    observationCount: aircraft.reduce((sum, item) => sum + item.observations.length, 0),
    aircraft,
    interpretation: [
      'Every coordinate and timestamp is an exact retained receiver-replay sample; no position is interpolated.',
      'For each identifier, geometry uses the provider with more retained observations inside the 10 km context radius. The other provider is recorded as a cross-check where available.',
      'Straight connectors may be rendered only between adjacent source observations with a short gap and plausible implied speed.',
      'Low-level means at least one retained observation at or below 5000 ft. It does not establish a firefighting role.',
      'Presence inside the radius does not establish an incident assignment, and receiver coverage is incomplete.',
      'The confirmed incident aircraft G10 is intentionally excluded here because it is published separately with stronger provenance.',
    ],
  }

  if (!result.aircraftCount || !result.observationCount) throw new Error('Snapshot would be empty')
  if (result.aircraft.some((item) => !item.observations.length)) throw new Error('Snapshot contains an aircraft without observations')
  const outputPath = path.resolve(options.output)
  const summaryOutputPath = path.resolve(options.summaryOutput)
  await mkdir(path.dirname(outputPath), { recursive: true })
  await mkdir(path.dirname(summaryOutputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  const { aircraft: omittedAircraft, ...summary } = result
  await writeFile(summaryOutputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({
    output: outputPath,
    summaryOutput: summaryOutputPath,
    aircraftCount: result.aircraftCount,
    lowLevelAircraftCount: result.lowLevelAircraftCount,
    overflightAircraftCount: result.overflightAircraftCount,
    observationCount: result.observationCount,
    crossCheckedAircraftCount: aircraft.filter((item) => item.observedBy.length > 1).length,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
