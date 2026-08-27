#!/usr/bin/env node

import assert from 'node:assert/strict'

import {
  SOURCE_FADE_WINDOWS_MS,
  annotateEffisGeometryFreshness,
  effisGeometryOpacityAt,
  linearSourceOpacity,
} from '../src/sourceFreshness.js'

const observedAt = Date.parse('2026-08-17T12:00:00.000Z')
assert.equal(linearSourceOpacity(observedAt, observedAt, 60_000), 1)
assert.equal(linearSourceOpacity(observedAt, observedAt + 30_000, 60_000), 0.5)
assert.equal(linearSourceOpacity(observedAt, observedAt + 60_000, 60_000), 0)
assert.equal(linearSourceOpacity(observedAt, observedAt - 1, 60_000), 0)

const ring = (offset) => [[
  [50.5 + offset, 6.0],
  [50.5 + offset, 6.1],
  [50.6 + offset, 6.1],
  [50.5 + offset, 6.0],
]]
const products = annotateEffisGeometryFreshness([
  { productDate: '2026-08-14', rings: ring(0) },
  { productDate: '2026-08-15', rings: ring(0.01) },
  { productDate: '2026-08-16', rings: ring(0.02) },
  { productDate: '2026-08-17', rings: ring(0.03) },
  { productDate: '2026-08-18', rings: ring(0.03) },
  { productDate: '2026-08-27', rings: ring(0.03) },
])
assert.deepEqual(products.map((product) => product.geometryObservedDate), [
  '2026-08-14',
  '2026-08-15',
  '2026-08-16',
  '2026-08-17',
  '2026-08-17',
  '2026-08-17',
])
assert.deepEqual(products.map((product) => product.geometryChanged), [true, true, true, true, false, false])

const repeated = products.at(-1)
const evidenceStartMs = Date.parse('2026-08-17T00:00:00+02:00')
assert.equal(effisGeometryOpacityAt(repeated, evidenceStartMs), 1)
assert.equal(effisGeometryOpacityAt(repeated, evidenceStartMs + 36 * 60 * 60 * 1000), 0.5)
assert.equal(effisGeometryOpacityAt(repeated, evidenceStartMs + SOURCE_FADE_WINDOWS_MS.effisGeometry), 0)

console.log(JSON.stringify({
  effisGeometryObservedDate: repeated.geometryObservedDate,
  effisFadeHours: SOURCE_FADE_WINDOWS_MS.effisGeometry / 3_600_000,
  firmsFadeHours: SOURCE_FADE_WINDOWS_MS.firmsPolar / 3_600_000,
  radarFadeMinutes: SOURCE_FADE_WINDOWS_MS.precipitationRadar / 60_000,
}, null, 2))
