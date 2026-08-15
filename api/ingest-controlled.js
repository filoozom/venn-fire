import { timingSafeEqual } from 'node:crypto'

import {
  MAX_SOURCE_BYTES,
  persistIncidentPerimeter,
  persistPublicOperations,
  persistRoadEvents,
  ROAD_SOURCE_URL,
} from '../server/controlled-sources.mjs'
import { databaseQuery, setNoStoreHeaders } from '../server/database.mjs'

function authorized(request, expectedToken) {
  const supplied = String(request.headers.authorization ?? '').replace(/^Bearer\s+/iu, '')
  if (!expectedToken || !supplied) return false
  const expectedBuffer = Buffer.from(expectedToken)
  const suppliedBuffer = Buffer.from(supplied)
  return expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer)
}

function requestBody(request) {
  if (Buffer.isBuffer(request.body)) return request.body.toString('utf8')
  if (typeof request.body === 'string') return request.body
  if (request.body && typeof request.body === 'object') return JSON.stringify(request.body)
  return ''
}

export default async function handler(request, response) {
  setNoStoreHeaders(response)
  response.setHeader('Access-Control-Allow-Methods', 'POST')
  if (request.method !== 'POST') return response.status(405).json({ ok: false, error: 'Method not allowed' })

  const expectedToken = process.env.CONTROLLED_SOURCE_INGEST_TOKEN?.trim()
  if (!expectedToken) return response.status(503).json({ ok: false, error: 'Controlled-source ingestion is not configured' })
  if (!authorized(request, expectedToken)) return response.status(401).json({ ok: false, error: 'Unauthorized' })

  const source = Array.isArray(request.query?.source) ? request.query.source[0] : request.query?.source
  const rawBody = requestBody(request)
  if (!rawBody) return response.status(400).json({ ok: false, error: 'Request body is required' })
  if (Buffer.byteLength(rawBody) > MAX_SOURCE_BYTES) {
    return response.status(413).json({ ok: false, error: `Payload exceeds ${MAX_SOURCE_BYTES} bytes` })
  }

  try {
    const query = databaseQuery()
    const retrievedAt = new Date().toISOString()
    let result
    if (source === 'road-events') {
      result = await persistRoadEvents({
        rawBody,
        retrievedAt,
        sourceUrl: ROAD_SOURCE_URL,
        ingestMode: 'push',
      }, query)
    } else if (source === 'official-perimeter') {
      result = await persistIncidentPerimeter({
        rawBody,
        retrievedAt,
        sourceUrl: 'agency-push:official-perimeter',
        ingestMode: 'push',
      }, query)
    } else if (source === 'public-operations') {
      result = await persistPublicOperations({
        rawBody,
        retrievedAt,
        sourceUrl: 'agency-push:public-operations',
        ingestMode: 'push',
      }, query)
    } else {
      return response.status(400).json({ ok: false, error: 'Unknown controlled source' })
    }
    return response.status(202).json({ ok: true, source, retrievedAt, itemCount: result.itemCount })
  } catch (error) {
    console.error('Controlled-source ingestion failed:', error?.message || error)
    return response.status(422).json({ ok: false, source, error: String(error?.message || error) })
  }
}

