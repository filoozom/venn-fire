import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

import { saveArtifact } from './database.mjs'

function safeArtifactPart(value) {
  return String(value || 'unknown').replace(/[^a-z0-9._-]+/giu, '-')
}

export function buildProviderArtifact({
  sourceKey,
  bucketAt,
  response,
}) {
  const providerId = response.provider?.id || response.providerId || 'unknown-provider'
  const responseId = [providerId, response.icao24].filter(Boolean).join('-')
  const fallback = JSON.stringify({
    ok: false,
    statusCode: response.statusCode ?? null,
    error: response.error || 'Provider request failed without a response body',
  })
  const rawBody = response.rawBody == null ? fallback : String(response.rawBody)
  const bytes = Buffer.from(rawBody)
  const compressed = gzipSync(bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return {
    artifactKey: `${safeArtifactPart(sourceKey)}:${bucketAt}:${safeArtifactPart(responseId)}`,
    sourceKey,
    originalPath: response.originalPath || response.provider?.endpoint || response.provider?.website || 'provider-request',
    contentType: response.contentType || 'application/octet-stream',
    contentEncoding: 'gzip',
    originalSize: bytes.byteLength,
    sha256,
    capturedAt: bucketAt,
    contentBase64: compressed.toString('base64'),
    providerId,
    icao24: response.icao24 || null,
    statusCode: response.statusCode ?? null,
  }
}

export async function archiveProviderResponses({
  sourceKey,
  bucketAt,
  responses = [],
}, query) {
  const artifacts = responses.map((response) => buildProviderArtifact({ sourceKey, bucketAt, response }))
  await Promise.all(artifacts.map((artifact) => saveArtifact(artifact, query)))
  return artifacts.map(({ contentBase64, ...artifact }) => artifact)
}

