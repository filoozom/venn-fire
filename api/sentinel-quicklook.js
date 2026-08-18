import { loadArtifact } from '../server/database.mjs'
import { respondNotModified, sendBytes, setImmutableCacheHeaders } from '../server/http-response.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export default async function handler(request, response) {
  // Quicklooks are keyed by the scene's immutable asset id.
  setImmutableCacheHeaders(response)
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (request.method === 'OPTIONS') return response.status(204).end()
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' })

  const id = Array.isArray(request.query?.id) ? request.query.id[0] : request.query?.id
  if (!UUID.test(String(id ?? ''))) {
    response.setHeader('Cache-Control', 'no-store, max-age=0')
    return response.status(400).json({ error: 'A valid quicklook asset id is required' })
  }

  try {
    const artifact = await loadArtifact(`sentinel2-quicklook-${id}`)
    if (!artifact || artifact.sourceKey !== 'sentinel2' || artifact.contentEncoding !== 'identity') {
      response.setHeader('Cache-Control', 'no-store, max-age=0')
      return response.status(404).json({ error: 'Quicklook not found' })
    }
    const etag = `"${artifact.sha256}"`
    if (respondNotModified(request, response, etag)) return undefined
    return sendBytes(request, response, Buffer.from(artifact.contentBase64, 'base64'), {
      contentType: artifact.contentType,
      etag,
      disposition: `inline; filename="sentinel2-${id}.jpg"`,
    })
  } catch (error) {
    console.error('Sentinel quicklook read failed:', error?.message || error)
    response.setHeader('Cache-Control', 'no-store, max-age=0')
    return response.status(503).json({ error: 'Database read failed' })
  }
}
