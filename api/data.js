import { databaseOverview, loadPublicDatasets } from '../server/database.mjs'
import { PUBLIC_DATASET_KEYS } from '../server/public-datasets.mjs'
import { entityTag, respondNotModified, sendJson, setSharedCacheHeaders } from '../server/http-response.mjs'

const DATA_SCOPES = Object.freeze({
  all: PUBLIC_DATASET_KEYS,
  core: PUBLIC_DATASET_KEYS.filter((key) => key !== 'aircraft'),
  aircraft: ['aircraft'],
})

// The client builds its timeline up to generatedAt floored to a five-minute
// frame, so two responses inside the same bucket produce an identical view.
// Bucketing lets the entity tag stay stable across that window while still
// changing the moment the timeline gains a frame.
const TIMELINE_BUCKET_MS = 5 * 60 * 1000

// Long enough that a burst of viewers costs one origin read, short enough that
// the view is never more than a minute behind the database.
const EDGE_MAX_AGE_SECONDS = 60
const EDGE_STALE_WHILE_REVALIDATE_SECONDS = 300

function requestScope(request) {
  const queryValue = Array.isArray(request.query?.scope) ? request.query.scope[0] : request.query?.scope
  return String(queryValue || 'all').toLowerCase()
}

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (request.method === 'OPTIONS') return response.status(204).end()
  if (request.method !== 'GET') {
    response.setHeader('Cache-Control', 'no-store, max-age=0')
    return response.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  try {
    const scope = requestScope(request)
    const keys = DATA_SCOPES[scope]
    if (!keys) {
      response.setHeader('Cache-Control', 'no-store, max-age=0')
      return response.status(400).json({ ok: false, error: 'Unknown data scope' })
    }
    const [datasets, database] = await Promise.all([
      loadPublicDatasets(keys),
      scope === 'aircraft' ? Promise.resolve(null) : databaseOverview(),
    ])

    setSharedCacheHeaders(response, {
      maxAgeSeconds: EDGE_MAX_AGE_SECONDS,
      staleWhileRevalidateSeconds: EDGE_STALE_WHILE_REVALIDATE_SECONDS,
    })

    // generatedAt is a property of the response rather than of the data, so it
    // is deliberately excluded from the tag: including the exact instant would
    // make every tag unique and no revalidation could ever return 304.
    const etag = entityTag(JSON.stringify({
      scope,
      bucket: Math.floor(Date.now() / TIMELINE_BUCKET_MS),
      datasets,
      database,
    }))
    if (respondNotModified(request, response, etag)) return undefined

    return sendJson(request, response, {
      ok: true,
      generatedAt: new Date().toISOString(),
      scope,
      datasets,
      ...(database ? { database } : {}),
    }, { etag })
  } catch (error) {
    console.error('Database read failed:', error?.message || error)
    response.setHeader('Cache-Control', 'no-store, max-age=0')
    return response.status(503).json({
      ok: false,
      generatedAt: new Date().toISOString(),
      datasets: {},
      error: 'Database read failed',
    })
  }
}
