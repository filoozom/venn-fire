import { loadArtifact } from '../server/database.mjs'
import { respondNotModified, sendBytes, setImmutableCacheHeaders } from '../server/http-response.mjs'

const ALLOWED_PREFIXES = new Map([
  ['cams-image:', 'cams'],
  ['dwd-radar-image:', 'dwd-radar-history'],
  ['nasa-gibs-image:', 'nasa-gibs'],
  ['rmi-radar-image:', 'rmi-radar'],
  ['sentinel1-thumbnail:', 'sentinel1'],
  ['sentinel3-frp-thumbnail:', 'sentinel3-frp'],
])
const OPAQUE_ID = /^[A-Za-z0-9_-]{8,512}$/u

function requestedArtifact(id) {
  if (!OPAQUE_ID.test(String(id ?? ''))) return null
  try {
    const artifactKey = Buffer.from(String(id), 'base64url').toString('utf8')
    if (artifactKey.length < 8 || artifactKey.length > 380) return null
    const match = [...ALLOWED_PREFIXES.entries()].find(([prefix]) => artifactKey.startsWith(prefix))
    return match ? { artifactKey, sourceKey: match[1] } : null
  } catch {
    return null
  }
}

export default async function handler(request, response) {
  // The id encodes the artifact key including its content hash, so a given URL
  // can only ever resolve to one image. It was being served no-store, which
  // meant every view re-read it from Postgres and re-billed the transfer.
  setImmutableCacheHeaders(response)
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (request.method === 'OPTIONS') return response.status(204).end()
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' })

  const id = Array.isArray(request.query?.id) ? request.query.id[0] : request.query?.id
  const requested = requestedArtifact(id)
  if (!requested) {
    response.setHeader('Cache-Control', 'no-store, max-age=0')
    return response.status(400).json({ error: 'A valid source image id is required' })
  }

  try {
    const artifact = await loadArtifact(requested.artifactKey)
    if (!artifact || artifact.sourceKey !== requested.sourceKey || artifact.contentEncoding !== 'identity'
      || !artifact.contentType.startsWith('image/')) {
      response.setHeader('Cache-Control', 'no-store, max-age=0')
      return response.status(404).json({ error: 'Source image not found' })
    }
    const etag = `"${artifact.sha256}"`
    if (respondNotModified(request, response, etag)) return undefined
    return sendBytes(request, response, Buffer.from(artifact.contentBase64, 'base64'), {
      contentType: artifact.contentType,
      etag,
      disposition: 'inline',
    })
  } catch (error) {
    console.error('Source image read failed:', error?.message || error)
    response.setHeader('Cache-Control', 'no-store, max-age=0')
    return response.status(503).json({ error: 'Database read failed' })
  }
}
