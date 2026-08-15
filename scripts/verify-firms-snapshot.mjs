#!/usr/bin/env node

// Independently re-checks the bundled FIRMS snapshot against the retained source
// responses. It re-parses every raw CSV from scratch and confirms that each
// published detection is an exact source row, that the derived hectare figures
// recompute to the published values, and that no key leaked into the snapshot.
//
// The ignored .local-data source documents must be present to run this.

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import {
  FIRMS_SENSORS,
  detectionFootprint,
  estimateFootprintArea,
  meetsConfidence,
  parseFirmsCsv,
  summarizeSensorDetections,
} from '../src/firmsDetections.js'

const DEFAULTS = {
  input: '',
  snapshot: 'src/firmsDetectionsSnapshot.json',
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

async function readJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'))
}

function detectionKey(detection) {
  // Coordinates are compared as published strings so a re-derived value can
  // never be accepted in place of an exact source coordinate.
  return [
    detection.latitude.toFixed(6),
    detection.longitude.toFixed(6),
    detection.acquiredAt,
    detection.sensorKey,
  ].join('|')
}

function distanceKm(left, right) {
  const radians = Math.PI / 180
  const deltaLatitude = (right.latitude - left.latitude) * radians
  const deltaLongitude = (right.longitude - left.longitude) * radians
  const value = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(left.latitude * radians) * Math.cos(right.latitude * radians)
      * Math.sin(deltaLongitude / 2) ** 2
  return 6371.0088 * 2 * Math.asin(Math.sqrt(value))
}

async function main() {
  const options = parseArgs(process.argv)
  const snapshot = await readJson(options.snapshot)
  const inputDir = path.resolve(options.input || `.local-data/firms/${snapshot.incidentDate}`)
  const rawDir = path.join(inputDir, 'raw')

  let rawFiles
  try {
    rawFiles = (await readdir(rawDir)).filter((name) => name.endsWith('.csv'))
  } catch {
    throw new Error(`Retained source responses not found at ${rawDir}. Run the importer first.`)
  }
  assert.ok(rawFiles.length, `No retained CSV responses in ${rawDir}`)

  // 1. Re-parse every retained response from scratch.
  const sourceDetections = new Map()
  for (const fileName of rawFiles) {
    const apiSource = fileName.replace(/\.csv$/, '')
    const sensor = FIRMS_SENSORS.find((candidate) => candidate.apiSource === apiSource)
    assert.ok(sensor, `Retained response ${fileName} does not match a known sensor`)

    const body = await readFile(path.join(rawDir, fileName), 'utf8')
    const { detections } = parseFirmsCsv(body, sensor)
    for (const detection of detections) sourceDetections.set(detectionKey(detection), detection)
  }

  // 2. Every published detection must be an exact retained source row.
  for (const published of snapshot.detections) {
    const source = sourceDetections.get(detectionKey(published))
    assert.ok(source, `Published detection has no retained source row: ${detectionKey(published)}`)
    assert.equal(published.latitude, source.latitude, 'Published latitude differs from the source')
    assert.equal(published.longitude, source.longitude, 'Published longitude differs from the source')
    assert.equal(published.acquiredAt, source.acquiredAt, 'Published timestamp differs from the source')
    assert.equal(published.frpMw, source.frpMw, 'Published FRP differs from the source')
    assert.equal(published.confidence.label, source.confidence.label, 'Published confidence differs from the source')
    assert.equal(published.scanKm, source.scanKm, 'Published scan dimension differs from the source')
    assert.equal(published.trackKm, source.trackKm, 'Published track dimension differs from the source')
    assert.ok(
      distanceKm(snapshot.locationReference, published) <= (snapshot.selection?.radiusKm ?? 15),
      `Published detection lies outside the incident radius: ${detectionKey(published)}`,
    )

    // 3. Footprint geometry must be reproducible from the published detection.
    assert.deepEqual(
      published.footprint,
      detectionFootprint(source),
      'Published footprint does not reproduce from the source pixel dimensions',
    )
  }

  // 4. Each sensor summary must recompute from the retained responses.
  for (const sensorSummary of snapshot.sensors) {
    const sensor = FIRMS_SENSORS.find((candidate) => candidate.key === sensorSummary.sensorKey)
    assert.ok(sensor, `Snapshot references an unknown sensor: ${sensorSummary.sensorKey}`)

    const forSensor = [...sourceDetections.values()].filter((detection) => (
      detection.sensorKey === sensor.key
      && distanceKm(snapshot.locationReference, detection) <= (snapshot.selection?.radiusKm ?? 15)
    ))
    const recomputed = summarizeSensorDetections({
      sensor,
      detections: forSensor,
      requestUrl: sensorSummary.sourceRequestUrl,
      retrievedAt: sensorSummary.retrievedAt,
      minimumConfidence: snapshot.minimumConfidence,
      origin: {
        latitude: snapshot.locationReference.latitude,
        longitude: snapshot.locationReference.longitude,
      },
    })

    assert.equal(sensorSummary.detectionCount, recomputed.detectionCount,
      `${sensor.name}: published detection count does not recompute`)

    // Drawn and counted must be the same set: every detection the snapshot tags
    // as meeting the threshold, and no others, must be in the published count.
    const tagged = snapshot.detections.filter(
      (detection) => detection.sensorKey === sensor.key && detection.meetsMinimumConfidence,
    )
    assert.equal(tagged.length, sensorSummary.detectionCount,
      `${sensor.name}: ${tagged.length} detections are tagged as counted but the published count is ${sensorSummary.detectionCount}`)
    for (const detection of tagged) {
      assert.equal(meetsConfidence(detection, snapshot.minimumConfidence), true,
        `${sensor.name}: a detection tagged as counted does not clear the snapshot threshold`)
    }
    assert.ok(Math.abs(sensorSummary.areaHa - recomputed.areaHa) < 1e-6,
      `${sensor.name}: published hectare estimate does not recompute`)
    assert.equal(sensorSummary.areaMethod, recomputed.areaMethod,
      `${sensor.name}: published method string does not match the method actually used`)

    // 5. The estimate can never be published without its labelling.
    assert.equal(sensorSummary.areaIsEstimate, true, `${sensor.name}: estimate is not flagged as an estimate`)
    assert.ok(sensorSummary.areaDisclaimer?.includes('Not a burned area'),
      `${sensor.name}: estimate is missing its disclaimer`)
    assert.equal(sensorSummary.source, 'NASA FIRMS', `${sensor.name}: estimate is missing its source`)
    assert.ok(sensorSummary.sourceRequestUrl, `${sensor.name}: estimate is missing its request URL`)
    assert.ok(sensorSummary.caveats?.length, `${sensor.name}: estimate is missing its caveats`)
  }

  // 6. Sensor estimates must never have been summed into a combined figure.
  assert.equal(snapshot.combinedAreaHa, undefined,
    'Snapshot publishes a combined hectare figure; per-sensor estimates must not be added together')

  // 7. No MAP_KEY may appear anywhere in the snapshot.
  const serialised = JSON.stringify(snapshot)
  for (const url of snapshot.sensors.map((summary) => summary.sourceRequestUrl)) {
    assert.ok(url.includes('/MAP_KEY/'), `Request URL is not in its key-free form: ${url}`)
  }
  assert.ok(!/[?&]MAP_KEY=/.test(serialised), 'Snapshot appears to contain a MAP_KEY query parameter')

  // 8. Independent sanity check on the union, recomputed here rather than trusted.
  const allRetained = [...sourceDetections.values()].filter(
    (detection) => distanceKm(snapshot.locationReference, detection) <= (snapshot.selection?.radiusKm ?? 15),
  )
  const independent = estimateFootprintArea(allRetained, {
    origin: {
      latitude: snapshot.locationReference.latitude,
      longitude: snapshot.locationReference.longitude,
    },
  })
  assert.ok(independent.unionHa <= independent.sumHa + 1e-6,
    'Union area exceeds the sum of footprints, which is geometrically impossible')

  console.log(`Verified ${snapshot.detections.length} detection(s) across ${snapshot.sensors.length} sensor(s).`)
  for (const sensorSummary of snapshot.sensors) {
    console.log(`  ${sensorSummary.sensorName.padEnd(18)} ${String(sensorSummary.detectionCount).padStart(4)} detections  `
      + `${sensorSummary.areaHa.toFixed(2)} ha (estimate)`)
  }
  console.log('Every published point matches a retained source row; every estimate recomputes and is labelled.')
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exitCode = 1
})
