import { createHash } from 'node:crypto'

import { loadDataset, saveArtifact, saveDataset } from './database.mjs'

export const LEGACY_REPORT_MIGRATION_KEY = 'migration-report-history-a80aa9a'
export const LEGACY_REPORT_SOURCE_URL = 'https://raw.githubusercontent.com/filoozom/venn-fire/a80aa9a0aa60f6b98d5c559805a1b626bc7ae004/src/data.js'
export const LEGACY_REPORT_SOURCE_SHA256 = '4dd097bc029d67b59ac1896499b9068a02ff7e3c2ebb14c5a0200828d1c15e50'

function stringProperty(block, property) {
  return new RegExp(`${property}:\\s*'([^']*)'`, 'u').exec(block)?.[1] ?? null
}

export function parseLegacyReportSource(sourceText) {
  const source = String(sourceText)
  const body = /export const areaReports = \[([\s\S]*?)\n\]\n\nexport function mergeAreaReports/u.exec(source)?.[1]
  if (!body) throw new Error('Immutable report source has no areaReports array')
  const blocks = [...body.matchAll(/\{([\s\S]*?)\n\s*\},?/gu)].map((match) => match[1])
  const reports = blocks.flatMap((block) => {
    const timestamp = /timestampMs:\s*Date\.parse\('([^']+)'\)/u.exec(block)?.[1]
    const reportedHa = Number(/reportedHa:\s*(\d+)/u.exec(block)?.[1])
    const areaPrefix = stringProperty(block, 'areaPrefix')
    const areaLabel = stringProperty(block, 'areaLabel')
    const publisher = stringProperty(block, 'source')
    const sourceUrl = stringProperty(block, 'sourceUrl')
    const timestampMs = Date.parse(timestamp)
    if (!Number.isFinite(timestampMs) || !Number.isFinite(reportedHa)
      || !['~', '>', '<', '='].includes(areaPrefix)
      || !areaLabel || !publisher || !sourceUrl) return []
    const observedAt = new Date(timestampMs).toISOString()
    return [{
      timestampMs,
      observedAt,
      effectiveTimestampMs: timestampMs,
      effectiveAt: observedAt,
      publishedAtMs: timestampMs,
      publishedAt: observedAt,
      reportedHa,
      areaPrefix,
      areaLabel,
      source: publisher,
      sourceUrl,
      sourceKind: publisher === 'BRF' ? 'local-reporting' : 'official',
      timestampBasis: 'timestamp retained in checksum-validated immutable pre-database revision',
    }]
  })
  if (reports.length !== blocks.length || reports.length !== 5) {
    throw new Error(`Immutable report source parsed ${reports.length}/${blocks.length} report rows; expected 5`)
  }
  return reports
}

export async function backfillLegacyReportHistory({ requestedAtMs, query }) {
  const existing = await loadDataset(LEGACY_REPORT_MIGRATION_KEY, query)
  if (existing) return { ...existing.payload, applied: false }

  const response = await fetch(LEGACY_REPORT_SOURCE_URL, {
    headers: {
      Accept: 'text/plain',
      'User-Agent': 'Venn-Fire-Watch/1.0 (+https://venn-fire.vercel.app/)',
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Legacy report history returned HTTP ${response.status}`)
  const sourceText = await response.text()
  const bytes = Buffer.from(sourceText)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== LEGACY_REPORT_SOURCE_SHA256) {
    throw new Error('Legacy report history failed immutable checksum validation')
  }
  const reports = parseLegacyReportSource(sourceText)
  const migratedAt = new Date(requestedAtMs).toISOString()
  await saveArtifact({
    artifactKey: `report-history-legacy:${LEGACY_REPORT_SOURCE_SHA256}`,
    sourceKey: 'reports-legacy',
    originalPath: LEGACY_REPORT_SOURCE_URL,
    contentType: response.headers.get('content-type')?.split(';')[0] || 'text/plain',
    contentEncoding: 'identity',
    originalSize: bytes.byteLength,
    sha256,
    capturedAt: migratedAt,
    contentBase64: bytes.toString('base64'),
  }, query)
  const payload = {
    schemaVersion: 1,
    migratedAt,
    sourceUrl: LEGACY_REPORT_SOURCE_URL,
    sha256,
    reportCount: reports.length,
    reports,
  }
  await saveDataset({ key: LEGACY_REPORT_MIGRATION_KEY, payload }, query)
  return { ...payload, applied: true }
}
