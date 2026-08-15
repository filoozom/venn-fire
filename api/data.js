import { databaseOverview, loadDatasets, setNoStoreHeaders } from '../server/database.mjs'

const PUBLIC_DATASET_KEYS = new Set([
  'aircraft',
  'effis',
  'ems',
  'firms',
  'incident-config',
  'media-reports',
  'official-perimeter',
  'public-alerts',
  'public-operations',
  'reports',
  'road-events',
  'sentinel2',
  'source-registry',
  'weather-dwd',
  'weather-open-meteo',
  'weather-rmi',
])

export default async function handler(request, response) {
  setNoStoreHeaders(response)
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (request.method === 'OPTIONS') return response.status(204).end()
  if (request.method !== 'GET') return response.status(405).json({ ok: false, error: 'Method not allowed' })

  try {
    const [allDatasets, database] = await Promise.all([loadDatasets(), databaseOverview()])
    const datasets = Object.fromEntries(
      Object.entries(allDatasets).filter(([key]) => PUBLIC_DATASET_KEYS.has(key)),
    )
    return response.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      datasets,
      database,
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
