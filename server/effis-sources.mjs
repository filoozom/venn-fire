import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'

import { loadDataset, saveArtifact, saveDataset } from './database.mjs'

export const LEGACY_EFFIS_MIGRATION_KEY = 'migration-effis-history-a80aa9a'
export const LEGACY_EFFIS_SOURCE_URL = 'https://raw.githubusercontent.com/filoozom/venn-fire/a80aa9a0aa60f6b98d5c559805a1b626bc7ae004/src/effisBurnedArea.js'
export const LEGACY_EFFIS_SOURCE_SHA256 = '82fbdfd5faf1248d33706634354649de512b350cdde3f89a18827f855fcd41b1'

function validRings(rings) {
  return Array.isArray(rings) && rings.length > 0 && rings.every((ring) => (
    Array.isArray(ring) && ring.length >= 4 && ring.every((point) => (
      Array.isArray(point) && point.length === 2
      && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))
    ))
  ))
}

export function parseLegacyEffisSource(sourceText) {
  const executable = String(sourceText)
    .replaceAll('export const ', 'const ')
    .replaceAll('export function ', 'function ')
    .concat('\n;globalThis.__effisProducts = effisBurnedAreas;')
  const sandbox = Object.create(null)
  runInNewContext(executable, sandbox, {
    timeout: 250,
    contextCodeGeneration: { strings: false, wasm: false },
  })
  const products = JSON.parse(JSON.stringify(sandbox.__effisProducts || []))
  const expectedDates = ['2026-08-14', '2026-08-15']
  if (JSON.stringify(products.map((product) => product.productDate)) !== JSON.stringify(expectedDates)
    || products.some((product) => product.source !== 'Copernicus EFFIS'
      || !Number.isFinite(Number(product.areaHa)) || Number(product.areaHa) <= 0
      || !validRings(product.rings))) {
    throw new Error('Immutable EFFIS source failed product validation')
  }
  return products
}

export async function backfillLegacyEffisHistory({ requestedAtMs, query }) {
  const existing = await loadDataset(LEGACY_EFFIS_MIGRATION_KEY, query)
  if (existing) return { ...existing.payload, applied: false }

  const response = await fetch(LEGACY_EFFIS_SOURCE_URL, {
    headers: {
      Accept: 'text/plain',
      'User-Agent': 'Venn-Fire-Watch/1.0 (+https://venn-fire.vercel.app/)',
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Legacy EFFIS history returned HTTP ${response.status}`)
  const sourceText = await response.text()
  const bytes = Buffer.from(sourceText)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== LEGACY_EFFIS_SOURCE_SHA256) {
    throw new Error('Legacy EFFIS history failed immutable checksum validation')
  }
  const recovered = parseLegacyEffisSource(sourceText)
  const migratedAt = new Date(requestedAtMs).toISOString()
  await saveArtifact({
    artifactKey: `effis-history-legacy:${LEGACY_EFFIS_SOURCE_SHA256}`,
    sourceKey: 'effis-history-legacy',
    originalPath: LEGACY_EFFIS_SOURCE_URL,
    contentType: response.headers.get('content-type')?.split(';')[0] || 'text/plain',
    contentEncoding: 'identity',
    originalSize: bytes.byteLength,
    sha256,
    capturedAt: migratedAt,
    contentBase64: bytes.toString('base64'),
  }, query)

  const current = (await loadDataset('effis', query))?.payload ?? { products: [] }
  const byDate = new Map((current.products || []).map((product) => [product.productDate, product]))
  recovered.forEach((product) => byDate.set(product.productDate, product))
  const products = [...byDate.values()].sort((left, right) => left.productDate.localeCompare(right.productDate))
  await saveDataset({
    key: 'effis',
    payload: { ...current, schemaVersion: current.schemaVersion || 1, generatedAt: migratedAt, products },
  }, query)
  const payload = {
    schemaVersion: 1,
    migratedAt,
    sourceUrl: LEGACY_EFFIS_SOURCE_URL,
    sha256,
    productCount: recovered.length,
    productDates: recovered.map((product) => product.productDate),
  }
  await saveDataset({ key: LEGACY_EFFIS_MIGRATION_KEY, payload }, query)
  return { ...payload, applied: true }
}
