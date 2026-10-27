import { Worker } from 'node:worker_threads'
import { entityTag } from './http-response.mjs'

const CACHE_BYTES = 64 * 1024 * 1024
const cache = new Map()
let cacheBytes = 0

export async function renderRasters(input, request, signal) {
  signal?.throwIfAborted()
  const geometry = { width: request.width, height: request.height, bbox: request.bbox, crs: request.crs }
  const result = new Map(), missing = []
  for (const { overlay, bytes } of input) {
    // Image bytes and visual inputs allow reuse across dates, selections and data refreshes.
    const key = entityTag(JSON.stringify([geometry, overlay.bounds, overlay.crs, overlay.opacity, overlay.sourceKey, entityTag(bytes)]))
    const image = cache.get(key)
    if (image) {
      cache.delete(key)
      cache.set(key, image)
      result.set(overlay.key, { input: image })
    } else missing.push({ key, overlay, bytes })
  }
  if (!missing.length) return result
  const worker = new Worker(new URL('./wms-raster-worker.mjs', import.meta.url), { workerData: { input: missing, request: geometry } })
  let abort
  try {
    const images = await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason)
      signal?.addEventListener('abort', abort, { once: true })
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', (code) => reject(new Error(`Raster worker exited before completing its map (${code})`)))
    })
    signal?.throwIfAborted()
    for (const { key, layerKey, bytes } of images) {
      const image = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      result.set(layerKey, { input: image })
      if (image.length > CACHE_BYTES) continue
      if (cache.has(key)) {
        cacheBytes -= cache.get(key).length
        cache.delete(key)
      }
      while ((cacheBytes + image.length > CACHE_BYTES || cache.size >= 128) && cache.size) {
        const first = cache.keys().next().value
        cacheBytes -= cache.get(first).length
        cache.delete(first)
      }
      cache.set(key, image)
      cacheBytes += image.length
    }
    return result
  } finally {
    signal?.removeEventListener('abort', abort)
    await worker.terminate()
  }
}
