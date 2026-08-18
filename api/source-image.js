import { loadArtifact, setNoStoreHeaders } from '../server/database.mjs'

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
  setNoStoreHeaders(response)
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (request.method === 'OPTIONS') return response.status(204).end()
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' })

  const id = Array.isArray(request.query?.id) ? request.query.id[0] : request.query?.id
  const requested = requestedArtifact(id)
  if (!requested) return response.status(400).json({ error: 'A valid source image id is required' })

  try {
    const artifact = await loadArtifact(requested.artifactKey)
    if (!artifact || artifact.sourceKey !== requested.sourceKey || artifact.contentEncoding !== 'identity'
      || !artifact.contentType.startsWith('image/')) {
      return response.status(404).json({ error: 'Source image not found' })
    }
    response.setHeader('Content-Type', artifact.contentType)
    response.setHeader('Content-Length', String(artifact.originalSize))
    response.setHeader('ETag', `"${artifact.sha256}"`)
    response.setHeader('Content-Disposition', 'inline')
    return response.status(200).end(Buffer.from(artifact.contentBase64, 'base64'))
  } catch (error) {
    console.error('Source image read failed:', error?.message || error)
    return response.status(503).json({ error: 'Database read failed' })
  }
}
