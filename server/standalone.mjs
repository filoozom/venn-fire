#!/usr/bin/env node
// Self-hosted entry point. On Vercel each api/*.js file is its own function and
// the platform serves the built client, runs the cron and drives the refresh
// chain through a queue. Off-platform there is one long-lived process, so this
// server does the same four jobs directly: serve dist/, route the read API
// through the same handler files, keep the schema current, and refresh sources
// on the shared cadence instead of a deployment-pinned queue chain.
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import process from 'node:process'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

import dataHandler from '../api/data.js'
import deploymentHandler from '../api/deployment.js'
import firmsSituationHandler from '../api/firms-situation.js'
import liveReportsHandler from '../api/live-reports.js'
import liveSituationHandler from '../api/live-situation.js'
import sentinelQuicklookHandler from '../api/sentinel-quicklook.js'
import sourceImageHandler from '../api/source-image.js'
import { databaseQuery, databaseUrl, ensureDatabaseSchema } from './database.mjs'
import { ensureFlightHistorySchema } from './flight-history.mjs'
import { closePostgresPools } from './postgres.mjs'
import { REFRESH_INTERVAL_MS, nextRefreshWakeAt } from './refresh-cadence.mjs'
import { withVercelRuntime } from './vercel-adapter.mjs'

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10)
const HOST = process.env.HOST?.trim() || '0.0.0.0'
const CLIENT_ROOT = resolve(process.env.CLIENT_ROOT?.trim() || 'dist')
const RUN_MIGRATIONS = process.env.RUN_MIGRATIONS !== 'false'
const REFRESH_ENABLED = process.env.REFRESH_ENABLED !== 'false'
const REFRESH_ON_BOOT = process.env.REFRESH_ON_BOOT === 'true'

const MIME_TYPES = new Map(Object.entries({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}))

// Only text benefits; woff2, png and webp are already compressed.
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|manifest\+json)|image\/svg\+xml)/u

const ROUTES = new Map(Object.entries({
  '/api/data': dataHandler,
  '/api/deployment': deploymentHandler,
  '/api/firms-situation': firmsSituationHandler,
  '/api/live-reports': liveReportsHandler,
  '/api/live-situation': liveSituationHandler,
  '/api/sentinel-quicklook': sentinelQuicklookHandler,
  '/api/source-image': sourceImageHandler,
}).map(([route, handler]) => [route, withVercelRuntime(handler)]))

// dist/ is immutable for the lifetime of a container, so a file is read and
// compressed at most once per encoding.
const assetCache = new Map()

function log(event, detail = {}) {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...detail }))
}

function negotiatedEncoding(request, contentType) {
  if (!COMPRESSIBLE.test(contentType)) return 'identity'
  const accepted = String(request.headers['accept-encoding'] ?? '').toLowerCase()
  if (/(^|[\s,])br([\s,;]|$)/u.test(accepted)) return 'br'
  if (/(^|[\s,])gzip([\s,;]|$)/u.test(accepted)) return 'gzip'
  return 'identity'
}

function encoded(body, encoding) {
  if (encoding === 'br') {
    return brotliCompressSync(body, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 5,
        [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    })
  }
  if (encoding === 'gzip') return gzipSync(body, { level: 6 })
  return body
}

// Keep every read inside dist/ regardless of what the URL asked for.
function resolvedAssetPath(pathname) {
  const decoded = decodeURIComponent(pathname)
  if (decoded.includes('\0')) return null
  const candidate = resolve(join(CLIENT_ROOT, normalize(decoded)))
  if (candidate !== CLIENT_ROOT && !candidate.startsWith(CLIENT_ROOT + sep)) return null
  return candidate
}

async function loadAsset(filePath) {
  if (assetCache.has(filePath)) return assetCache.get(filePath)
  const stats = await stat(filePath)
  if (!stats.isFile()) throw Object.assign(new Error('Not a file'), { code: 'ENOENT' })
  const body = await readFile(filePath)
  const asset = {
    body,
    contentType: MIME_TYPES.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
    etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`,
    variants: new Map(),
  }
  assetCache.set(filePath, asset)
  return asset
}

function serveAsset(request, response, asset, { immutable }) {
  response.setHeader('Content-Type', asset.contentType)
  response.setHeader('ETag', asset.etag)
  response.setHeader('Vary', 'Accept-Encoding')
  // Vite fingerprints everything under /assets/, so those may be cached
  // forever. index.html and the files copied from public/ keep their names
  // across releases and must be revalidated instead.
  response.setHeader(
    'Cache-Control',
    immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
  )

  const offered = String(request.headers['if-none-match'] ?? '')
    .split(',')
    .map((value) => value.trim().replace(/^W\//u, ''))
  if (offered.includes(asset.etag)) return response.writeHead(304).end()

  const encoding = negotiatedEncoding(request, asset.contentType)
  if (!asset.variants.has(encoding)) asset.variants.set(encoding, encoded(asset.body, encoding))
  const body = asset.variants.get(encoding)
  if (encoding !== 'identity') response.setHeader('Content-Encoding', encoding)
  response.setHeader('Content-Length', String(body.length))
  if (request.method === 'HEAD') return response.writeHead(200).end()
  return response.writeHead(200).end(body)
}

// A request for a named file is not a navigation. Falling back to index.html for
// one answers a dead asset URL with 200 and an HTML body, which surfaces as a
// stylesheet MIME error rather than the missing file it is -- exactly what a
// client holding a stale index.html sees after a redeploy. Only extensionless
// paths get the single-page fallback.
function looksLikeFileRequest(pathname) {
  return pathname.split('/').pop()?.includes('.') ?? false
}

async function serveClient(request, response, pathname) {
  const direct = resolvedAssetPath(pathname)
  if (!direct) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    return response.end('Bad request')
  }

  if (pathname !== '/') {
    try {
      const asset = await loadAsset(direct)
      return serveAsset(request, response, asset, { immutable: pathname.startsWith('/assets/') })
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error
    }

    if (looksLikeFileRequest(pathname)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      return response.end('Not found')
    }
  }

  // Single-page app: unknown paths render the client, which routes internally.
  const index = await loadAsset(join(CLIENT_ROOT, 'index.html'))
  return serveAsset(request, response, index, { immutable: false })
}

async function checkHealth(response) {
  try {
    await databaseQuery()('SELECT 1')
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return response.end(JSON.stringify({ ok: true, database: 'reachable' }))
  } catch (error) {
    response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return response.end(JSON.stringify({ ok: false, error: error?.message || 'Database unreachable' }))
  }
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  try {
    if (pathname === '/healthz') return await checkHealth(response)

    const route = ROUTES.get(pathname)
    if (route) return await route(request, response)

    if (pathname.startsWith('/api/')) {
      response.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      return response.end(JSON.stringify({ ok: false, error: 'Unknown API route' }))
    }

    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
      return response.end('Method not allowed')
    }

    return await serveClient(request, response, pathname)
  } catch (error) {
    log('request-failed', { pathname, error: error?.message || String(error) })
    if (response.headersSent) return response.destroy()
    response.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return response.end(JSON.stringify({ ok: false, error: 'Internal error' }))
  }
})

// --- source refresh --------------------------------------------------------

let refreshTimer = null
let refreshing = false

async function runRefresh(reason) {
  if (refreshing) {
    log('refresh-skipped', { reason, why: 'previous run still in progress' })
    return
  }
  refreshing = true
  const startedAt = Date.now()
  try {
    // Imported lazily so the queue-backed scheduler, which requires Vercel
    // deployment variables, is never loaded here.
    const { refreshAllSources } = await import('./refresh-sources.mjs')
    const sources = await refreshAllSources({ requestedAtMs: startedAt })
    const failed = sources.filter((source) => source.status === 'failed')
    log('refresh-complete', {
      reason,
      durationMs: Date.now() - startedAt,
      sources: sources.length,
      failed: failed.map((source) => source.key ?? source.sourceKey ?? 'unknown'),
    })
  } catch (error) {
    // A failing source must never take the web server down with it.
    log('refresh-failed', { reason, durationMs: Date.now() - startedAt, error: error?.message || String(error) })
  } finally {
    refreshing = false
  }
}

function scheduleRefresh() {
  const delay = Math.max(1_000, nextRefreshWakeAt(Date.now()) - Date.now())
  refreshTimer = setTimeout(() => {
    void runRefresh('scheduled').finally(scheduleRefresh)
  }, delay)
  refreshTimer.unref?.()
  log('refresh-scheduled', { inSeconds: Math.round(delay / 1_000), intervalMs: REFRESH_INTERVAL_MS })
}

// --- lifecycle -------------------------------------------------------------

let shuttingDown = false

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  log('shutdown', { signal })
  if (refreshTimer) clearTimeout(refreshTimer)
  await new Promise((done) => server.close(done))
  await closePostgresPools()
  process.exit(0)
}

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void shutdown(signal))
process.on('unhandledRejection', (error) => log('unhandled-rejection', { error: error?.message || String(error) }))

async function start() {
  if (!databaseUrl()) {
    throw new Error('Set DATABASE_URL (or PGHOST/PGPASSWORD/PG_CA_PEM) before starting the server')
  }

  if (RUN_MIGRATIONS) {
    const query = databaseQuery()
    await ensureDatabaseSchema(query)
    await ensureFlightHistorySchema(query)
    log('schema-ready', {})
  }

  await new Promise((listening) => server.listen(PORT, HOST, listening))
  log('listening', { host: HOST, port: PORT, clientRoot: CLIENT_ROOT, refresh: REFRESH_ENABLED })

  if (REFRESH_ENABLED) {
    if (REFRESH_ON_BOOT) void runRefresh('boot')
    scheduleRefresh()
  }
}

await start()
