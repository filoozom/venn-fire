import { readFile } from 'node:fs/promises'
import { loadArtifact, loadPublicDatasets } from '../server/database.mjs'
import { entityTag, respondNotModified, sendBytes } from '../server/http-response.mjs'
import { capabilitiesXml, exceptionXml, mapRequest, snapshotTime, wmsError, wmsLayers, wmsParameters } from '../server/wms.mjs'
import { renderMap } from '../server/wms-render.mjs'
import { mergeIncidentFlights, runtimeDataFromResponse } from '../src/data.js'
import { firmsDetectionsForMap } from '../src/mapState.js'
import { requestedArtifact } from './source-image.js'

const DATASET_KEYS = ['incident-config', 'weather-open-meteo', 'weather-rmi', 'weather-dwd', 'reports', 'firms', 'effis', 'aircraft', 'sentinel2', 'sentinel3-frp', 'rmi-radar', 'dwd-radar-history', 'nasa-gibs', 'cams']
const IMAGE_PREFIXES = { 'nasa-gibs': 'nasa-gibs-image:', cams: 'cams-image:', 'rmi-radar': 'rmi-radar-image:', 'dwd-radar-history': 'dwd-radar-image:' }
const CACHE_BYTES = 32 * 1024 * 1024
let snapshotPromise, snapshotExpires = 0
let renderingRevision

function renderRevision() {
  // Calculation/style edits must invalidate conditional responses even when data is unchanged.
  renderingRevision ??= Promise.all([
    './wms.js', './source-image.js', '../server/wms.mjs', '../server/wms-render.mjs',
    ...['mapState', 'mapStyles', 'data', 'sourceFreshness', 'firmsDetections', 'aircraftTracks', 'aircraftFireEstimate', 'fireActivityEstimate', 'modisFireEstimate', 'camsForecasts'].map((name) => `../src/${name}.js`),
  ].map((path) => readFile(new URL(path, import.meta.url)))).then((parts) => entityTag(Buffer.concat(parts)))
  return renderingRevision
}

async function databaseSnapshot() {
  if (snapshotPromise && Date.now() < snapshotExpires) return snapshotPromise
  // Infinity also coalesces concurrent readers while the first database read is pending.
  snapshotExpires = Infinity
  snapshotPromise = (async () => {
    const datasets = await loadPublicDatasets(DATASET_KEYS)
    const runtime = runtimeDataFromResponse({ ok: true, generatedAt: new Date().toISOString(), datasets }, { singleFrame: true })
    const flights = mergeIncidentFlights(runtime.flights, runtime.aircraft.observations ?? [])
    const detections = firmsDetectionsForMap(runtime.firms.detections ?? [], runtime.timelineStartMs)
    const layers = wmsLayers(runtime, flights, detections)
    const revision = entityTag(JSON.stringify(Object.entries(datasets).map(([key, value]) => [key, value.contentHash])))
    snapshotExpires = Date.now() + 60_000
    return { runtime, flights, detections, layers, revision }
  })().catch((error) => {
    snapshotPromise = undefined
    snapshotExpires = 0
    throw error
  })
  return snapshotPromise
}

export async function retainedImage(overlay, readArtifact = loadArtifact) {
  const id = new URL(overlay.image.databaseUrl, 'http://localhost').searchParams.get('id')
  const key = overlay.image.artifactKey ?? requestedArtifact(id)?.artifactKey
  const prefix = IMAGE_PREFIXES[overlay.sourceKey]
  if (!prefix || typeof key !== 'string' || !key.startsWith(prefix)) throw new Error('Invalid retained image reference')
  const artifact = await readArtifact(key)
  if (!artifact || artifact.sourceKey !== overlay.sourceKey || artifact.contentEncoding !== 'identity'
    || !['image/png', 'image/jpeg'].includes(artifact.contentType) || artifact.originalSize > 16 * 1024 * 1024) {
    throw new Error('Retained image is unavailable or invalid')
  }
  return Buffer.from(artifact.contentBase64, 'base64')
}

function serviceUrl(request, parameters) {
  const protocol = request.headers?.['x-forwarded-proto'] === 'https' || request.socket?.encrypted ? 'https' : 'http'
  const origin = new URL(`${protocol}://${request.headers?.host || 'venn.apyos.com'}`)
  const endpoint = new URL('/wms', origin)
  // GIS clients use the advertised URL for GetMap, dropping the original query.
  if (parameters.has('TIME')) endpoint.searchParams.set('TIME', parameters.get('TIME'))
  return endpoint.href
}

export function createWmsHandler({ getSnapshot = databaseSnapshot, loadImage = retainedImage } = {}) {
  const cache = new Map(), pending = new Map()
  const waiting = []
  let cacheBytes = 0, rendering = 0
  return async function handler(request, response) {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    response.setHeader('Access-Control-Expose-Headers', 'ETag, X-WMS-Time')
    response.setHeader('Cache-Control', 'no-store')
    if (request.method === 'OPTIONS') return response.status(204).end()
    try {
      if (!['GET', 'HEAD'].includes(request.method)) throw wmsError('OperationNotSupported', 'Use GET, HEAD or OPTIONS', 405)
      const { parameters, operation } = wmsParameters(request.url)
      const bundle = await getSnapshot()
      if (response.destroyed) return
      let body, etag, contentType
      if (operation === 'getcapabilities') {
        const timestampMs = snapshotTime(parameters.get('TIME') ?? 'current', bundle.runtime)
        body = Buffer.from(capabilitiesXml(bundle.layers, bundle.runtime, serviceUrl(request, parameters), timestampMs))
        etag = entityTag(body)
        contentType = 'text/xml; charset=utf-8'
      } else {
        const map = mapRequest(parameters, bundle.layers, bundle.runtime)
        response.setHeader('X-WMS-Time', new Date(map.timestampMs).toISOString())
        etag = entityTag(JSON.stringify([await renderRevision(), bundle.revision, map]))
        if (response.destroyed) return
        contentType = 'image/png'
        response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
        if (respondNotModified(request, response, etag)) return
        body = cache.get(etag)
        if (body) {
          cache.delete(etag)
          cache.set(etag, body)
        } else {
          if (!pending.has(etag)) {
            const job = { clients: new Set(), controller: new AbortController(), started: false }
            let ready, cancelWaiting
            if (rendering >= 2) {
              if (waiting.length >= 6) {
                response.setHeader('Retry-After', '1')
                throw wmsError('ServerBusy', 'Map rendering queue is full; retry shortly', 503)
              }
              ready = new Promise((resolve) => {
                const resume = () => { job.started = true; resolve() }
                waiting.push(resume)
                cancelWaiting = () => {
                  const index = waiting.indexOf(resume)
                  if (index >= 0) waiting.splice(index, 1)
                  resolve()
                }
              })
            } else {
              rendering += 1
              job.started = true
              ready = Promise.resolve()
            }
            job.cancel = () => {
              job.controller.abort()
              cancelWaiting?.()
              if (pending.get(etag) === job) pending.delete(etag)
            }
            job.promise = ready.then(() => {
              job.controller.signal.throwIfAborted()
              return renderMap(bundle, map, loadImage, job.controller.signal)
            }).then((image) => {
              job.controller.signal.throwIfAborted()
              if (image.length <= CACHE_BYTES) {
                while ((cacheBytes + image.length > CACHE_BYTES || cache.size >= 128) && cache.size) {
                  const first = cache.keys().next().value
                  cacheBytes -= cache.get(first).length
                  cache.delete(first)
                }
                cache.set(etag, image)
                cacheBytes += image.length
              }
              return image
            }).finally(() => {
              if (job.started) {
                const next = waiting.shift()
                if (next) next()
                else rendering -= 1
              }
              if (pending.get(etag) === job) pending.delete(etag)
            })
            pending.set(etag, job)
          }
          const job = pending.get(etag)
          job.clients.add(response)
          const disconnect = () => {
            job.clients.delete(response)
            if (!job.clients.size) job.cancel()
          }
          response.once?.('close', disconnect)
          try {
            body = await job.promise
          } finally {
            response.off?.('close', disconnect)
            job.clients.delete(response)
          }
          if (response.destroyed) return
        }
      }
      response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
      if (respondNotModified(request, response, etag)) return
      if (request.method === 'HEAD') {
        response.setHeader('Content-Type', contentType)
        response.setHeader('Content-Length', String(body.length))
        response.setHeader('ETag', etag)
        return response.status(200).end()
      }
      return sendBytes(request, response, body, { contentType, etag })
    } catch (error) {
      if (response.destroyed) return
      const publicError = error.status ? error : wmsError('NoApplicableCode', 'Retained data or map rendering is unavailable', 503)
      if (!error.status) console.error('WMS failed:', error.message)
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Type', 'text/xml; charset=utf-8')
      return response.status(publicError.status).end(request.method === 'HEAD' ? undefined : exceptionXml(publicError))
    }
  }
}

export default createWmsHandler()
