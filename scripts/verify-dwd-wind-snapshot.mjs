#!/usr/bin/env node

// Independently checks every bundled DWD wind observation against the retained
// recent/now archives. No network access is used.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const snapshot = JSON.parse(await readFile('src/dwdWindObservations.json', 'utf8'))
const rawDir = path.resolve('.local-data/dwd', snapshot.window.start.slice(0, 10), 'raw')

function toIso(raw) {
  const value = String(raw).trim()
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:00Z`
}

function sourceKey(stationId, observedAt) {
  return `${stationId}|${observedAt}`
}

const sourceRows = new Map()
for (const station of snapshot.stations) {
  for (const kind of ['recent', 'now']) {
    const archivePath = path.join(rawDir, `${station.id}-${kind}.zip`)
    const { stdout } = await execFileAsync('unzip', ['-p', archivePath], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    const lines = stdout.trim().split(/\r?\n/)
    const headers = lines.shift().split(';').map((value) => value.trim())
    const index = Object.fromEntries(headers.map((header, position) => [header, position]))
    for (const line of lines) {
      const cells = line.split(';')
      const observedAt = toIso(cells[index.MESS_DATUM])
      const timestampMs = Date.parse(observedAt)
      if (timestampMs < Date.parse(snapshot.window.start) || timestampMs > Date.parse(snapshot.window.end)) continue
      const windSpeedMs = Number(cells[index.FF_10])
      const windDirection = Number(cells[index.DD_10])
      if (windSpeedMs <= -900 || windDirection <= -900) continue
      sourceRows.set(sourceKey(station.id, observedAt), {
        stationId: station.id,
        observedAt,
        windSpeedMs,
        windDirection,
        qualityLevel: Number(cells[index.QN]),
        archiveKind: kind,
      })
    }
  }
}

assert.equal(snapshot.qualityStatus, 'preliminary')
assert.equal(snapshot.selection.radiusKm, 40)
assert.equal(snapshot.stations.length, 3)
assert.equal(snapshot.observations.length, sourceRows.size)

for (const observation of snapshot.observations) {
  const source = sourceRows.get(sourceKey(observation.stationId, observation.observedAt))
  assert.ok(source, `No retained DWD row for ${sourceKey(observation.stationId, observation.observedAt)}`)
  assert.equal(observation.windSpeedMs, source.windSpeedMs)
  assert.equal(observation.windSpeedKmh, source.windSpeedMs * 3.6)
  assert.equal(observation.windDirection, source.windDirection)
  assert.equal(observation.qualityLevel, source.qualityLevel)
  assert.equal(observation.archiveKind, source.archiveKind)
}

for (const station of snapshot.stations) {
  assert.ok(station.distanceKm <= snapshot.selection.radiusKm)
  const rows = snapshot.observations.filter((observation) => observation.stationId === station.id)
  assert.ok(rows.length, `${station.name} has no observations`)
  for (let index = 1; index < rows.length; index += 1) {
    assert.equal(
      Date.parse(rows[index].observedAt) - Date.parse(rows[index - 1].observedAt),
      snapshot.cadenceMinutes * 60_000,
      `${station.name} has an unexpected cadence gap at ${rows[index].observedAt}`,
    )
  }
}

console.log(`Verified ${snapshot.observations.length} exact DWD wind rows from all ${snapshot.stations.length} stations within 40 km.`)
