#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const INPUTS = {
  'airplanes-live': '.local-data/airplanes-live/2026-08-14/area-scan.json',
  'adsb-lol': '.local-data/adsb-lol/2026-08-14/area-scan.json',
}
const SNAPSHOT_PATH = 'src/nearbyTrafficSnapshot.json'
const DROSSART = { latitude: 50.54762, longitude: 6.05757 }
const SELECTION_RADIUS_KM = 5
const CONTEXT_RADIUS_KM = 10
const EXCLUDED = new Set(['44c1e5'])

async function readJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'))
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

function byHex(scan) {
  const result = new Map()
  for (const observation of scan.observations) {
    if (!result.has(observation.hex)) result.set(observation.hex, [])
    result.get(observation.hex).push({ ...observation, distanceKm: haversineKm(observation) })
  }
  for (const observations of result.values()) {
    observations.sort((left, right) => left.observedAt.localeCompare(right.observedAt))
  }
  return result
}

function expectedPublishedObservation(observation) {
  return {
    observedAt: observation.observedAt,
    latitude: observation.lat,
    longitude: observation.lon,
    altitudeFt: typeof observation.altitude === 'number' ? observation.altitude : null,
    distanceDrossartKm: Number(observation.distanceKm.toFixed(3)),
  }
}

async function main() {
  const [snapshot, ...documents] = await Promise.all([
    readJson(SNAPSHOT_PATH),
    ...Object.values(INPUTS).map(readJson),
  ])
  const providers = Object.keys(INPUTS).map((id, index) => ({ id, observationsByHex: byHex(documents[index]) }))
  const expectedIds = new Set()
  for (const provider of providers) {
    for (const [hex, observations] of provider.observationsByHex) {
      if (!EXCLUDED.has(hex) && observations.some((observation) => observation.distanceKm <= SELECTION_RADIUS_KM)) {
        expectedIds.add(hex)
      }
    }
  }

  assert.equal(snapshot.aircraft.length, expectedIds.size, 'snapshot identifier count must equal the two-provider union')
  assert.equal(snapshot.aircraftCount, expectedIds.size, 'manifest aircraftCount must match the array')
  assert.deepEqual(new Set(snapshot.aircraft.map((aircraft) => aircraft.icao24)), expectedIds, 'snapshot must contain exactly the selected identifiers')
  assert.equal(snapshot.selection.selectionRadiusKm, SELECTION_RADIUS_KM, 'selection radius mismatch')
  assert.equal(snapshot.selection.contextRadiusKm, CONTEXT_RADIUS_KM, 'context radius mismatch')
  assert.deepEqual(new Set(snapshot.selection.excludedIncidentAircraft), EXCLUDED, 'excluded incident-aircraft set mismatch')

  let verifiedObservationCount = 0
  for (const aircraft of snapshot.aircraft) {
    const coverage = providers.map((provider) => {
      const all = provider.observationsByHex.get(aircraft.icao24) || []
      return {
        ...provider,
        selection: all.filter((observation) => observation.distanceKm <= SELECTION_RADIUS_KM),
        context: all.filter((observation) => observation.distanceKm <= CONTEXT_RADIUS_KM),
      }
    }).filter((provider) => provider.selection.length)
    const observedBy = coverage.map((provider) => provider.id)
    assert.deepEqual(aircraft.observedBy, observedBy, `${aircraft.icao24}: observedBy mismatch`)

    const chosen = coverage.find((provider) => provider.id === aircraft.geometrySource)
    assert.ok(chosen, `${aircraft.icao24}: geometry source did not observe the aircraft inside 5 km`)
    const expectedGeometrySource = [...coverage].sort((left, right) => (
      right.context.length - left.context.length
      || providers.findIndex((provider) => provider.id === left.id)
        - providers.findIndex((provider) => provider.id === right.id)
    ))[0]
    assert.equal(chosen.id, expectedGeometrySource.id, `${aircraft.icao24}: geometry source is not the densest retained replay`)
    assert.equal(aircraft.observations.length, chosen.context.length, `${aircraft.icao24}: context observation count mismatch`)
    assert.deepEqual(
      aircraft.observations,
      chosen.context.map(expectedPublishedObservation),
      `${aircraft.icao24}: published observation sequence differs from the selected source replay`,
    )
    assert.equal(aircraft.observationsWithinSelectionRadius, chosen.selection.length, `${aircraft.icao24}: selected-radius count mismatch`)
    assert.deepEqual(
      aircraft.providerObservationCounts,
      Object.fromEntries(coverage.map((provider) => [provider.id, provider.context.length])),
      `${aircraft.icao24}: provider context counts mismatch`,
    )
    assert.deepEqual(
      aircraft.providerSelectionCounts,
      Object.fromEntries(coverage.map((provider) => [provider.id, provider.selection.length])),
      `${aircraft.icao24}: provider selection counts mismatch`,
    )
    assert.equal(aircraft.firstObservedAt, chosen.context[0]?.observedAt || null, `${aircraft.icao24}: first observation mismatch`)
    assert.equal(aircraft.lastObservedAt, chosen.context.at(-1)?.observedAt || null, `${aircraft.icao24}: last observation mismatch`)

    verifiedObservationCount += aircraft.observations.length

    const allContext = coverage.flatMap((provider) => provider.context)
    assert.equal(
      aircraft.nearestDrossartKm,
      Number(Math.min(...allContext.map((observation) => observation.distanceKm)).toFixed(3)),
      `${aircraft.icao24}: nearest-distance value mismatch`,
    )
    const minimumAltitudeFt = Math.min(...allContext
      .map((observation) => observation.altitude)
      .filter((altitude) => typeof altitude === 'number'))
    assert.equal(
      aircraft.classification,
      minimumAltitudeFt <= 5000 ? 'low-level' : 'overflight',
      `${aircraft.icao24}: altitude classification mismatch`,
    )
    assert.equal(aircraft.missionStatus, 'No incident role established', `${aircraft.icao24}: mission-status caveat mismatch`)
  }

  assert.equal(verifiedObservationCount, snapshot.observationCount, 'manifest observationCount must equal verified exact samples')
  assert.equal(
    snapshot.aircraft.filter((aircraft) => aircraft.classification === 'low-level').length,
    snapshot.lowLevelAircraftCount,
    'low-level count mismatch',
  )
  assert.equal(
    snapshot.aircraft.filter((aircraft) => aircraft.classification === 'overflight').length,
    snapshot.overflightAircraftCount,
    'overflight count mismatch',
  )

  process.stdout.write(`${JSON.stringify({
    status: 'verified',
    aircraftCount: snapshot.aircraftCount,
    exactSourceObservationCount: verifiedObservationCount,
    lowLevelAircraftCount: snapshot.lowLevelAircraftCount,
    overflightAircraftCount: snapshot.overflightAircraftCount,
    twoProviderAircraftCount: snapshot.aircraft.filter((aircraft) => aircraft.observedBy.length > 1).length,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
