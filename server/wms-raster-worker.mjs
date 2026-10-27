import { parentPort, workerData } from 'node:worker_threads'
import sharp from 'sharp'
import { reprojectRaster } from './wms-render.mjs'

const { input, request } = workerData
const projectionCache = {}, images = []
for (const { key, overlay, bytes } of input) {
  const image = await reprojectRaster(bytes, overlay, request, projectionCache)
  const png = await sharp(image.input, { raw: image.raw }).png({ compressionLevel: 1 }).toBuffer()
  images.push({ key, layerKey: overlay.key, bytes: png })
}
parentPort.postMessage(images)
