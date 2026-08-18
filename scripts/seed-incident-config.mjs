#!/usr/bin/env node
// Seeds the incident definition into a fresh database.
//
// incident-config is configuration rather than an ingested source: it carries
// the incident centre, the timeline start, the flight roster and the initial
// layer choices. refreshAllSources reads it and refuses to invent one, so on a
// virgin database the incident-map-context source fails and the viewer has no
// timeline to draw. Copying a whole database with scripts/copy-postgres.mjs
// needs Postgres credentials for the origin; this only needs its public API,
// which is all a self-hosted deployment normally has.
//
//   node scripts/seed-incident-config.mjs https://venn-fire.vercel.app
//   node scripts/seed-incident-config.mjs ./incident-config.json
import { readFile } from 'node:fs/promises'
import process from 'node:process'

import { databaseQuery, databaseUrl, ensureDatabaseSchema, loadDataset, rebuildPublicDatasets, saveDataset } from '../server/database.mjs'
import { closePostgresPools } from '../server/postgres.mjs'

const DATASET_KEY = 'incident-config'
const source = process.argv[2]

if (!source) {
  console.error('Usage: node scripts/seed-incident-config.mjs <origin-url | path-to-json>')
  process.exit(2)
}
if (!databaseUrl()) {
  throw new Error('Set DATABASE_URL (or PGHOST/PGPASSWORD/PG_CA_PEM) before seeding')
}

// Accepts a whole /api/data response, a single dataset wrapper, or a bare payload.
function extractPayload(document) {
  const candidate = document?.datasets?.[DATASET_KEY]?.payload
    ?? document?.payload
    ?? document
  if (!Array.isArray(candidate?.incidentCenter) || candidate.incidentCenter.length !== 2) {
    throw new Error('No usable incident-config payload found (expected an incidentCenter pair)')
  }
  if (!Number.isFinite(Number(candidate.timelineStartMs))) {
    throw new Error('incident-config payload is missing a numeric timelineStartMs')
  }
  return candidate
}

async function readSource(value) {
  if (/^https?:\/\//u.test(value)) {
    const url = new URL(value)
    // Bare origins are pointed at the public dataset endpoint.
    if (!url.pathname.includes('/api/')) url.pathname = '/api/data'
    if (!url.searchParams.has('scope')) url.searchParams.set('scope', 'core')
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`${url.href} returned HTTP ${response.status}`)
    return response.json()
  }
  return JSON.parse(await readFile(value, 'utf8'))
}

try {
  const payload = extractPayload(await readSource(source))
  const query = databaseQuery()
  await ensureDatabaseSchema(query)

  const existing = await loadDataset(DATASET_KEY, query)
  const stored = await saveDataset({
    key: DATASET_KEY,
    payload,
    sourceUpdatedAt: new Date().toISOString(),
  }, query)
  const publicDatasets = await rebuildPublicDatasets(query)

  console.log(JSON.stringify({
    ok: true,
    source,
    replacedExisting: Boolean(existing),
    changed: stored.changed,
    incidentCenter: payload.incidentCenter,
    timelineStartMs: payload.timelineStartMs,
    flights: payload.flights?.length ?? 0,
    mapLabels: payload.mapLabels?.length ?? 0,
    publicDatasets,
  }, null, 2))
} finally {
  await closePostgresPools()
}
