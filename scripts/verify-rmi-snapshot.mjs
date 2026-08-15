#!/usr/bin/env node

// Re-checks every bundled Mont Rigi value and validation flag against the exact
// retained RMI WFS response. No network access is used.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const SNAPSHOT_PATH = path.resolve('src/montRigiObservations.json')
const SOURCE_PATH = path.resolve('.local-data/rmi/2026-08-14/source-response.geojson')
const FIELDS = [
  ['wind_speed_10m', 'WIND_SPEED_10M'],
  ['wind_direction', 'WIND_DIRECTION'],
  ['wind_gusts_speed', 'WIND_GUSTS_SPEED'],
  ['humidity_rel_shelter_avg', 'HUMIDITY_REL_SHELTER_AVG'],
  ['temp_dry_shelter_avg', 'TEMP_DRY_SHELTER_AVG'],
  ['precip_quantity', 'PRECIP_QUANTITY'],
]

const [snapshot, source] = await Promise.all([
  readFile(SNAPSHOT_PATH, 'utf8').then(JSON.parse),
  readFile(SOURCE_PATH, 'utf8').then(JSON.parse),
])

assert.equal(snapshot.station.code, 6494)
assert.equal(snapshot.station.name, 'MONT RIGI')
assert.equal(snapshot.source.featureType, 'aws:aws_10min')
assert.equal(snapshot.observations.length, source.features.length)
assert.equal(snapshot.validationStatus, 'none-validated')

const sourceByTime = new Map(source.features.map((feature) => [feature.properties.timestamp, feature]))
let selectedValues = 0
let selectedValidatedValues = 0

for (const [index, observation] of snapshot.observations.entries()) {
  const feature = sourceByTime.get(observation.observedAt)
  assert.ok(feature, `No retained RMI row for ${observation.observedAt}`)
  assert.equal(feature.properties.code, snapshot.station.code)
  assert.deepEqual(feature.geometry.coordinates, [snapshot.station.longitude, snapshot.station.latitude])

  const validated = JSON.parse(feature.properties.qc_flags || '{}').validated || {}
  for (const [field, qcKey] of FIELDS) {
    const sourceValue = feature.properties[field] ?? null
    assert.equal(observation[field], sourceValue, `${observation.observedAt}: ${field} differs`)
    const expectedValidation = sourceValue == null ? null : validated[qcKey] === true
    assert.equal(
      observation[`${field}_validated`],
      expectedValidation,
      `${observation.observedAt}: ${field} validation flag differs`,
    )
    if (sourceValue != null) {
      selectedValues += 1
      if (expectedValidation) selectedValidatedValues += 1
    }
  }

  assert.equal(observation.wind_speed_10m_kmh, observation.wind_speed_10m * 3.6)
  assert.equal(observation.wind_gusts_speed_kmh, observation.wind_gusts_speed * 3.6)

  if (index > 0) {
    const previous = snapshot.observations[index - 1]
    assert.equal(
      Date.parse(observation.observedAt) - Date.parse(previous.observedAt),
      snapshot.cadenceMinutes * 60_000,
      `Unexpected station cadence before ${observation.observedAt}`,
    )
  }
}

assert.equal(selectedValidatedValues, 0, 'Snapshot says none validated but a selected field is validated')
assert.ok(snapshot.source.requestUrl.includes('code%3D6494'))

console.log(
  `Verified ${snapshot.observations.length} Mont Rigi observations and ${selectedValues} exact field values; none are yet RMI-validated.`,
)
