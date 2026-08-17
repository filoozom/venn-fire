import { databaseOverview, loadPublicDatasets, setNoStoreHeaders } from '../server/database.mjs'
import { PUBLIC_DATASET_KEYS } from '../server/public-datasets.mjs'

const DATA_SCOPES = Object.freeze({
  all: PUBLIC_DATASET_KEYS,
  core: PUBLIC_DATASET_KEYS.filter((key) => key !== 'aircraft'),
  aircraft: ['aircraft'],
})

function requestScope(request) {
  const queryValue = Array.isArray(request.query?.scope) ? request.query.scope[0] : request.query?.scope
  return String(queryValue || 'all').toLowerCase()
}

export default async function handler(request, response) {
  setNoStoreHeaders(response)
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (request.method === 'OPTIONS') return response.status(204).end()
  if (request.method !== 'GET') return response.status(405).json({ ok: false, error: 'Method not allowed' })

  try {
    const scope = requestScope(request)
    const keys = DATA_SCOPES[scope]
    if (!keys) return response.status(400).json({ ok: false, error: 'Unknown data scope' })
    const [datasets, database] = await Promise.all([
      loadPublicDatasets(keys),
      scope === 'aircraft' ? Promise.resolve(null) : databaseOverview(),
    ])
    return response.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      scope,
      datasets,
      ...(database ? { database } : {}),
    })
  } catch (error) {
    console.error('Database read failed:', error?.message || error)
    return response.status(503).json({
      ok: false,
      generatedAt: new Date().toISOString(),
      datasets: {},
      error: 'Database read failed',
    })
  }
}
