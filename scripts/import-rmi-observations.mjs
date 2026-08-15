#!/usr/bin/env node

// Royal Meteorological Institute of Belgium automatic weather station
// observations, from the official open-data WFS.
//
// Unlike the bundled Open-Meteo values, these are measurements from a physical
// station rather than a model grid point. MONT RIGI (code 6494) sits in the
// Hautes Fagnes about 4.2 km from the reported Drossart locality and reports
// every ten minutes.
//
// RMI publishes a per-field quality-control flag with every record. A value
// whose flag is not true has not been validated by RMI, so it is retained and
// marked rather than silently mixed in with validated measurements.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const WFS_ENDPOINT = 'https://opendata.meteo.be/service/ows'
const SOURCE_URL = 'https://opendata.meteo.be/'
const DROSSART = { latitude: 50.54762, longitude: 6.05757 }

// Confirmed against the aws:aws_station feature type.
const MONT_RIGI = {
  code: 6494,
  name: 'MONT RIGI',
  latitude: 50.5110,
  longitude: 6.0730,
  distanceKmFromDrossart: 4.2,
}

const MEASUREMENTS = [
  { field: 'wind_speed_10m', qcKey: 'WIND_SPEED_10M', unit: 'm/s', label: 'Wind speed at 10 m' },
  { field: 'wind_direction', qcKey: 'WIND_DIRECTION', unit: 'degrees', label: 'Wind direction' },
  { field: 'wind_gusts_speed', qcKey: 'WIND_GUSTS_SPEED', unit: 'm/s', label: 'Wind gust' },
  { field: 'humidity_rel_shelter_avg', qcKey: 'HUMIDITY_REL_SHELTER_AVG', unit: '%', label: 'Relative humidity' },
  { field: 'temp_dry_shelter_avg', qcKey: 'TEMP_DRY_SHELTER_AVG', unit: 'degC', label: 'Air temperature' },
  { field: 'precip_quantity', qcKey: 'PRECIP_QUANTITY', unit: 'mm', label: 'Precipitation' },
]

const DEFAULTS = {
  station: String(MONT_RIGI.code),
  start: '2026-08-14T11:00:00Z',
  end: '',
  output: '',
  snapshot: 'src/montRigiObservations.json',
  count: '1000',
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
  if (!options.output) options.output = `.local-data/rmi/${options.start.slice(0, 10)}`
  return options
}

function buildRequestUrl(options) {
  const parameters = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: 'aws:aws_10min',
    outputFormat: 'application/json',
    count: options.count,
    sortBy: 'timestamp',
    CQL_FILTER: `code=${options.station} AND timestamp DURING ${options.start}/${options.end}`,
  })
  return `${WFS_ENDPOINT}?${parameters}`
}

// RMI ships qc_flags as a JSON string. A field is validated only when its flag
// is exactly true; null means RMI published no verdict for it.
function parseQcFlags(rawValue) {
  try {
    return JSON.parse(rawValue ?? '{}')?.validated ?? {}
  } catch {
    return {}
  }
}

async function main() {
  const options = parseArgs(process.argv)
  const requestUrl = buildRequestUrl(options)

  if (options.dryRun) {
    console.log('Planned request, no network access:')
    console.log(`  ${requestUrl}`)
    console.log(`\nOutput would be written to ${options.output}/`)
    console.log(`Bundled snapshot ${options.writeSnapshot ? 'WOULD' : 'would NOT'} be replaced (${options.snapshot}).`)
    return
  }

  const outputDir = path.resolve(options.output)
  await mkdir(outputDir, { recursive: true })

  const retrievedAt = new Date().toISOString()
  process.stderr.write(`Fetching ${MONT_RIGI.name} (${options.station})\n`)
  const response = await fetch(requestUrl, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`RMI WFS returned HTTP ${response.status}`)
  const body = await response.text()

  // Retain the exact response before deriving anything from it.
  await writeFile(path.join(outputDir, 'source-response.geojson'), body, 'utf8')

  const payload = JSON.parse(body)
  const features = payload.features ?? []
  if (!features.length) throw new Error('RMI WFS returned no records for the requested window')

  const observations = []
  const unvalidatedCounts = {}

  for (const feature of features) {
    const properties = feature.properties ?? {}
    const validated = parseQcFlags(properties.qc_flags)
    const record = { observedAt: properties.timestamp }

    for (const measurement of MEASUREMENTS) {
      const value = properties[measurement.field]
      const isValidated = validated[measurement.qcKey] === true
      if (value != null && !isValidated) {
        unvalidatedCounts[measurement.field] = (unvalidatedCounts[measurement.field] ?? 0) + 1
      }
      record[measurement.field] = value ?? null
      record[`${measurement.field}_validated`] = value == null ? null : isValidated
    }

    // Derived for display only. The source unit is retained above and this value
    // is a unit conversion, never a new measurement.
    record.wind_speed_10m_kmh = record.wind_speed_10m == null ? null : record.wind_speed_10m * 3.6
    record.wind_gusts_speed_kmh = record.wind_gusts_speed == null ? null : record.wind_gusts_speed * 3.6

    observations.push(record)
  }

  observations.sort((first, second) => first.observedAt.localeCompare(second.observedAt))

  const manifest = {
    schemaVersion: 1,
    source: {
      name: 'Royal Meteorological Institute of Belgium (RMI) open data',
      url: SOURCE_URL,
      endpoint: WFS_ENDPOINT,
      featureType: 'aws:aws_10min',
      requestUrl,
    },
    retrievedAt,
    station: MONT_RIGI,
    locationReference: {
      name: 'Drossart locality (OpenStreetMap node 5770188072)',
      latitude: DROSSART.latitude,
      longitude: DROSSART.longitude,
      url: 'https://www.openstreetmap.org/node/5770188072',
    },
    window: { start: options.start, end: options.end },
    cadenceMinutes: 10,
    measurements: MEASUREMENTS,
    observationCount: observations.length,
    firstObservedAt: observations[0].observedAt,
    lastObservedAt: observations[observations.length - 1].observedAt,
    unvalidatedCounts,
    interpretation: [
      'Every value is a station measurement, not a model value and not interpolated.',
      `The station is ${MONT_RIGI.distanceKmFromDrossart} km from the reported Drossart locality; conditions at the fire front may differ.`,
      'A value is marked validated only when RMI published a true quality-control flag for that field.',
      'Wind is measured at 10 m above ground over open terrain and is not a measurement of wind inside the fire.',
      'Kilometre-per-hour values are unit conversions of the published metre-per-second measurements.',
    ],
  }

  // RMI validates records some time after publication, so a near-real-time
  // window normally arrives with every flag set to false. That is a statement
  // about validation status, not about the measurement being wrong, and it must
  // be shown rather than assumed away.
  const totalValues = observations.length * MEASUREMENTS.length
  const totalUnvalidated = Object.values(unvalidatedCounts).reduce((sum, count) => sum + count, 0)
  if (totalUnvalidated === totalValues) {
    manifest.validationStatus = 'none-validated'
    manifest.interpretation.push(
      'RMI has not yet quality-validated any value in this window. These are published near-real-time measurements awaiting validation, and every field is flagged accordingly.',
    )
  } else if (totalUnvalidated > 0) {
    manifest.validationStatus = 'partially-validated'
    manifest.interpretation.push(
      `RMI has validated some but not all values in this window; ${totalUnvalidated} of ${totalValues} remain unvalidated and are flagged per field.`,
    )
  } else {
    manifest.validationStatus = 'fully-validated'
  }

  await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await writeFile(
    path.join(outputDir, 'observations.json'),
    `${JSON.stringify(observations, null, 2)}\n`,
    'utf8',
  )

  const gusts = observations.map((record) => record.wind_gusts_speed).filter((value) => value != null)
  const humidity = observations.map((record) => record.humidity_rel_shelter_avg).filter((value) => value != null)
  const temperature = observations.map((record) => record.temp_dry_shelter_avg).filter((value) => value != null)

  console.log(`\nRetained ${observations.length} ten-minute records in ${outputDir}/`)
  console.log(`  window      ${manifest.firstObservedAt} to ${manifest.lastObservedAt}`)
  if (gusts.length) console.log(`  max gust    ${Math.max(...gusts).toFixed(1)} m/s (${(Math.max(...gusts) * 3.6).toFixed(1)} km/h)`)
  if (humidity.length) console.log(`  min humidity ${Math.min(...humidity).toFixed(1)} %`)
  if (temperature.length) console.log(`  max temp    ${Math.max(...temperature).toFixed(1)} degC`)
  if (Object.keys(unvalidatedCounts).length) {
    console.log(`  unvalidated values: ${JSON.stringify(unvalidatedCounts)}`)
  }

  if (!options.writeSnapshot) {
    console.log('\nBundled snapshot left untouched. Re-run with --write-snapshot to replace it.')
    return
  }

  await writeFile(
    path.resolve(options.snapshot),
    `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: retrievedAt,
      source: manifest.source,
      station: MONT_RIGI,
      cadenceMinutes: 10,
      measurements: MEASUREMENTS,
      validationStatus: manifest.validationStatus,
      interpretation: manifest.interpretation,
      observations,
    }, null, 2)}\n`,
    'utf8',
  )
  console.log(`\nWrote bundled snapshot ${options.snapshot}`)
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exitCode = 1
})
