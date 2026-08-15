import { databaseOverview, setNoStoreHeaders } from '../server/database.mjs'
import { refreshAllSources } from '../server/refresh-sources.mjs'
import {
  activateRefreshScheduler,
  scheduleNextRefresh,
} from '../server/refresh-scheduler.mjs'

export default async function handler(request, response) {
  setNoStoreHeaders(response)
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (request.method === 'OPTIONS') return response.status(204).end()
  if (!['GET', 'POST'].includes(request.method)) {
    return response.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  const requestedAtMs = Date.now()
  try {
    const deployment = await activateRefreshScheduler()
    const refreshPromise = refreshAllSources({ requestedAtMs })
    let scheduler
    try {
      scheduler = await scheduleNextRefresh({ nowMs: requestedAtMs })
    } catch (error) {
      console.error('Next refresh could not be queued:', error?.message || error)
      scheduler = { ok: false, error: 'Next refresh could not be queued' }
    }
    const sources = await refreshPromise
    const overview = await databaseOverview()
    const failed = sources.filter((source) => source.status === 'failed')
    return response.status(200).json({
      ok: failed.length === 0 && scheduler.ok,
      generatedAt: new Date(requestedAtMs).toISOString(),
      schedulerGranularityMinutes: 5,
      deployment,
      scheduler,
      sources,
      database: overview,
    })
  } catch (error) {
    console.error('Refresh orchestration failed:', error?.message || error)
    return response.status(503).json({
      ok: false,
      generatedAt: new Date(requestedAtMs).toISOString(),
      error: 'Refresh orchestration failed',
    })
  }
}
