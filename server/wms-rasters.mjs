import { Worker } from 'node:worker_threads'

export async function renderRasters(input, request, signal) {
  signal?.throwIfAborted()
  const geometry = { width: request.width, height: request.height, bbox: request.bbox, crs: request.crs }
  const result = new Map()
  if (!input.length) return result
  const worker = new Worker(new URL('./wms-raster-worker.mjs', import.meta.url), { workerData: { input, request: geometry } })
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
    for (const { layerKey, bytes } of images) {
      const image = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      result.set(layerKey, { input: image })
    }
    return result
  } finally {
    signal?.removeEventListener('abort', abort)
    await worker.terminate()
  }
}
