#!/usr/bin/env node

// Fetches NASA FIRMS active-fire detections once, with a key supplied at run
// time, and retains the exact source responses so every published point stays
// auditable. The key is never written to any output: manifests and snapshots
// record the key-free form of each request URL.
//
// The importer writes only to .local-data, which is ignored by Git. Replacing
// the bundled production snapshot requires the explicit --write-snapshot flag,
// so refreshing a local import can never silently change what the site serves.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  FIRMS_SENSORS,
  FOOTPRINT_ESTIMATE_CAVEATS,
  buildFirmsRequests,
  detectionFootprint,
  meetsConfidence,
  parseFirmsCsv,
  summarizeSensorDetections,
} from '../src/firmsDetections.js'

const DROSSART = { latitude: 50.54762, longitude: 6.05757 }
const INCIDENT_RADIUS_KM = 15
const REQUEST_DELAY_MS = 1100

const DEFAULTS = {
  date: '2026-08-14',
  dayRange: 2,
  bbox: '5.85,50.42,6.30,50.70',
  output: '',
  minimumConfidence: 'nominal',
  snapshot: 'src/firmsDetectionsSnapshot.json',
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
    options[key] = key === 'dayRange' ? Number(value) : value
    index += 1
  }
  if (!options.output) options.output = `.local-data/firms/${options.date}`
  return options
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function distanceDrossartKm(detection) {
  const radians = Math.PI / 180
  const deltaLatitude = (detection.latitude - DROSSART.latitude) * radians
  const deltaLongitude = (detection.longitude - DROSSART.longitude) * radians
  const value = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(DROSSART.latitude * radians) * Math.cos(detection.latitude * radians)
      * Math.sin(deltaLongitude / 2) ** 2
  return 6371.0088 * 2 * Math.asin(Math.sqrt(value))
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

// FIRMS answers an invalid key or an exhausted quota with HTTP 200 and a plain
// text body, so a successful status is not on its own evidence of data.
function describeNonCsvBody(body) {
  const trimmed = body.trim()
  if (!trimmed) return 'Empty response body'
  if (trimmed.toLowerCase().startsWith('invalid')) return trimmed.slice(0, 200)
  if (!trimmed.split(/\r?\n/)[0].includes('latitude')) {
    return `Response did not start with a FIRMS CSV header: ${trimmed.slice(0, 200)}`
  }
  return null
}

async function main() {
  const options = parseArgs(process.argv)
  const mapKey = process.env.FIRMS_MAP_KEY ?? ''
  const bbox = options.bbox.split(',').map(Number)
  if (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) {
    throw new Error('--bbox must be minLon,minLat,maxLon,maxLat')
  }

  if (options.dryRun) {
    // A dry run must never need a real key and must never contact NASA.
    const planned = buildFirmsRequests({
      mapKey: 'DRY_RUN', bbox, startDate: options.date, dayRange: options.dayRange,
    })
    console.log(`Planned ${planned.length} request(s), no network access, no key required:`)
    for (const request of planned) {
      console.log(`  ${request.sensor.name.padEnd(18)} ${request.citableUrl}`)
    }
    console.log(`\nOutput would be written to ${options.output}/`)
    console.log(`Bundled snapshot ${options.writeSnapshot ? 'WOULD' : 'would NOT'} be replaced (${options.snapshot}).`)
    console.log('\nSet FIRMS_MAP_KEY and re-run without --dry-run to fetch. Get a free key at')
    console.log('https://firms.modaps.eosdis.nasa.gov/api/map_key/')
    return
  }

  if (!mapKey) {
    throw new Error('FIRMS_MAP_KEY is not set. Export it for this run only, or use --dry-run to preview the requests.')
  }

  const outputDir = path.resolve(options.output)
  const rawDir = path.join(outputDir, 'raw')
  await mkdir(rawDir, { recursive: true })

  const requests = buildFirmsRequests({
    mapKey, bbox, startDate: options.date, dayRange: options.dayRange,
  })

  const summaries = []
  const errors = []
  const allDetections = []

  for (const [index, request] of requests.entries()) {
    if (index > 0) await delay(REQUEST_DELAY_MS)
    const retrievedAt = new Date().toISOString()
    process.stderr.write(`Fetching ${request.sensor.name}\n`)

    let body = ''
    let status = null
    try {
      const response = await fetch(request.url, { signal: AbortSignal.timeout(30_000) })
      status = response.status
      body = await response.text()
      if (!response.ok) throw new Error(`HTTP ${status}`)

      const complaint = describeNonCsvBody(body)
      if (complaint) throw new Error(complaint)
    } catch (error) {
      errors.push({ sensor: request.sensor.apiSource, status, detail: String(error.message ?? error) })
      continue
    }

    // Retain the exact response body before anything is derived from it.
    await writeFile(path.join(rawDir, `${request.sensor.apiSource}.csv`), body, 'utf8')

    const { detections, skippedRows } = parseFirmsCsv(body, request.sensor)
    const inRadius = detections.filter((detection) => distanceDrossartKm(detection) <= INCIDENT_RADIUS_KM)
    const excludedOutsideRadius = detections.length - inRadius.length
    allDetections.push(...inRadius)
    summaries.push(summarizeSensorDetections({
      sensor: request.sensor,
      detections: inRadius,
      skippedRows,
      requestUrl: request.citableUrl,
      retrievedAt,
      minimumConfidence: options.minimumConfidence,
      origin: DROSSART,
    }))
    summaries.at(-1).excludedOutsideRadius = excludedOutsideRadius
  }

  const manifest = {
    schemaVersion: 1,
    source: { name: 'NASA FIRMS', url: 'https://firms.modaps.eosdis.nasa.gov/' },
    normalizedAt: new Date().toISOString(),
    date: options.date,
    dayRange: options.dayRange,
    bbox: { minLon: bbox[0], minLat: bbox[1], maxLon: bbox[2], maxLat: bbox[3] },
    locationReference: {
      name: 'Drossart locality (OpenStreetMap node 5770188072)',
      latitude: DROSSART.latitude,
      longitude: DROSSART.longitude,
      url: 'https://www.openstreetmap.org/node/5770188072',
    },
    minimumConfidence: options.minimumConfidence,
    selection: { center: DROSSART, radiusKm: INCIDENT_RADIUS_KM },
    requests: requests.map((request) => ({ sensor: request.sensor.apiSource, url: request.citableUrl })),
    errors,
    summaries,
    interpretation: [
      'Every retained coordinate is an exact FIRMS detection centroid; no position is interpolated.',
      `Only detections within ${INCIDENT_RADIUS_KM} km of Drossart are retained.`,
      'A detection is a thermal anomaly at the moment of overpass, not a burned-area polygon.',
      'Hectare values are derived estimates from sensor pixel footprints and carry their method.',
      ...FOOTPRINT_ESTIMATE_CAVEATS,
    ],
  }
  await writeJson(path.join(outputDir, 'manifest.json'), manifest)

  // Footprint polygons in GeoJSON lon/lat order for external inspection.
  await writeJson(path.join(outputDir, 'detections.geojson'), {
    type: 'FeatureCollection',
    features: allDetections.map((detection) => ({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [detectionFootprint(detection).map(([lat, lon]) => [lon, lat])],
      },
      properties: {
        sensorKey: detection.sensorKey,
        satellite: detection.satellite,
        acquiredAt: detection.acquiredAt,
        confidence: detection.confidence.label,
        frpMw: detection.frpMw,
        brightnessK: detection.brightnessK,
        dayNight: detection.dayNight,
        footprintSource: detection.footprintSource,
      },
    })),
  })

  if (errors.length) {
    console.error(`\n${errors.length} sensor request(s) failed:`)
    for (const error of errors) console.error(`  ${error.sensor}: ${error.detail}`)
  }

  const plotted = summaries.reduce((total, summary) => total + summary.detectionCount, 0)
  console.log(`\nRetained ${plotted} detection(s) from ${summaries.length} sensor(s) in ${outputDir}/`)
  for (const summary of summaries) {
    console.log(`  ${summary.sensorName.padEnd(18)} ${String(summary.detectionCount).padStart(4)} detections  `
      + `${summary.areaHa.toFixed(1)} ha ${summary.areaMethod}`)
  }

  if (!options.writeSnapshot) {
    console.log('\nBundled snapshot left untouched. Re-run with --write-snapshot to replace it.')
    return
  }

  if (!summaries.length) {
    throw new Error('Refusing to write a snapshot with no sensor results')
  }

  const snapshot = {
    schemaVersion: 1,
    generatedAt: manifest.normalizedAt,
    incidentDate: options.date,
    locationReference: manifest.locationReference,
    bbox: manifest.bbox,
    minimumConfidence: options.minimumConfidence,
    selection: manifest.selection,
    sensors: summaries,
    // Every detection is carried so the viewer can lower the threshold, but each
    // one is tagged with the same confidence test that produced the counts above.
    // Drawing a point that no published count includes would misrepresent the
    // estimate, so the tag travels with the geometry.
    detections: allDetections.map((detection) => ({
      ...detection,
      footprint: detectionFootprint(detection),
      meetsMinimumConfidence: meetsConfidence(detection, options.minimumConfidence),
    })),
    interpretation: manifest.interpretation,
  }
  await writeJson(path.resolve(options.snapshot), snapshot)
  console.log(`\nWrote bundled snapshot ${options.snapshot}`)
  console.log('Run `pnpm verify:firms-snapshot` to re-check it against the retained responses.')
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exitCode = 1
})
