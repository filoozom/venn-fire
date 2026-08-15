import { loadArtifact, setNoStoreHeaders } from '../server/database.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export default async function handler(request, response) {
  setNoStoreHeaders(response)
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (request.method === 'OPTIONS') return response.status(204).end()
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' })

  const id = Array.isArray(request.query?.id) ? request.query.id[0] : request.query?.id
  if (!UUID.test(String(id ?? ''))) return response.status(400).json({ error: 'A valid quicklook asset id is required' })

  try {
    const artifact = await loadArtifact(`sentinel2-quicklook-${id}`)
    if (!artifact || artifact.sourceKey !== 'sentinel2' || artifact.contentEncoding !== 'identity') {
      return response.status(404).json({ error: 'Quicklook not found' })
    }
    response.setHeader('Content-Type', artifact.contentType)
    response.setHeader('Content-Length', String(artifact.originalSize))
    response.setHeader('ETag', `"${artifact.sha256}"`)
    response.setHeader('Content-Disposition', `inline; filename="sentinel2-${id}.jpg"`)
    return response.status(200).end(Buffer.from(artifact.contentBase64, 'base64'))
  } catch (error) {
    console.error('Sentinel quicklook read failed:', error?.message || error)
    return response.status(503).json({ error: 'Database read failed' })
  }
}
