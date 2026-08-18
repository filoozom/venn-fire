import { createHash } from 'node:crypto'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

// Vercel meters Fast Origin Transfer on the bytes a function hands to the Edge
// Network, before the edge compresses for the client. A 7 MB JSON body that
// reaches the browser as ~400 KB of brotli is still 7 MB of metered origin
// transfer, so the function has to do the compressing itself.
//
// Brotli quality 5 compresses the ~7 MB dataset response to ~360 KB in ~40 ms.
// Quality 11 saves a further 74 KB but takes ~3.9 s, which would dominate the
// function's own duration budget for no useful gain.
const BROTLI_QUALITY = 5
const GZIP_LEVEL = 6

// Below roughly a packet's worth, compression headers cost more than they save.
const MINIMUM_COMPRESSED_BYTES = 1024

const YEAR_SECONDS = 31_536_000

function negotiatedEncoding(request) {
  const accepted = String(request.headers?.['accept-encoding'] ?? '').toLowerCase()
  if (/(^|[\s,])br([\s,;]|$)/u.test(accepted)) return 'br'
  if (/(^|[\s,])gzip([\s,;]|$)/u.test(accepted)) return 'gzip'
  return 'identity'
}

function encodedBody(body, encoding) {
  if (encoding === 'br') {
    return brotliCompressSync(body, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    })
  }
  if (encoding === 'gzip') return gzipSync(body, { level: GZIP_LEVEL })
  return body
}

export function entityTag(value) {
  return `"${createHash('sha256').update(value).digest('base64url').slice(0, 32)}"`
}

// A short edge lifetime with background revalidation: many concurrent viewers
// collapse into one origin read instead of one each, and a revalidation that
// finds nothing new returns 304 rather than the whole body.
export function setSharedCacheHeaders(response, { maxAgeSeconds, staleWhileRevalidateSeconds }) {
  const shared = `public, s-maxage=${maxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`
  // max-age=0 keeps the browser revalidating on its own requests while still
  // allowing it to store the body, which is what makes its If-None-Match work.
  response.setHeader('Cache-Control', `public, max-age=0, must-revalidate, s-maxage=${maxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`)
  response.setHeader('CDN-Cache-Control', shared)
  response.setHeader('Vercel-CDN-Cache-Control', shared)
  response.removeHeader('Pragma')
}

// For content addressed by a hash of itself, which can never change under a
// given URL.
export function setImmutableCacheHeaders(response) {
  const value = `public, max-age=${YEAR_SECONDS}, immutable`
  response.setHeader('Cache-Control', value)
  response.setHeader('CDN-Cache-Control', value)
  response.setHeader('Vercel-CDN-Cache-Control', value)
  response.removeHeader('Pragma')
}

export function respondNotModified(request, response, etag) {
  const header = String(request.headers?.['if-none-match'] ?? '')
  if (!header) return false
  const offered = header.split(',').map((value) => value.trim().replace(/^W\//u, ''))
  if (!offered.includes('*') && !offered.includes(etag)) return false
  response.setHeader('ETag', etag)
  response.status(304).end()
  return true
}

export function sendJson(request, response, payload, { etag } = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const encoding = body.length >= MINIMUM_COMPRESSED_BYTES ? negotiatedEncoding(request) : 'identity'
  const encoded = encodedBody(body, encoding)
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  // The stored body differs per encoding, so caches must key on it.
  response.setHeader('Vary', 'Accept-Encoding')
  if (etag) response.setHeader('ETag', etag)
  if (encoding !== 'identity') response.setHeader('Content-Encoding', encoding)
  response.setHeader('Content-Length', String(encoded.length))
  return response.status(200).end(encoded)
}

export function sendBytes(request, response, bytes, { contentType, etag, disposition }) {
  response.setHeader('Content-Type', contentType)
  response.setHeader('Content-Length', String(bytes.length))
  if (etag) response.setHeader('ETag', etag)
  if (disposition) response.setHeader('Content-Disposition', disposition)
  return response.status(200).end(bytes)
}
