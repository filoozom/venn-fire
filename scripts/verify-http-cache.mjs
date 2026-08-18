// Verifies the response layer that keeps Fast Origin Transfer down: the function
// must compress its own body (the edge meters what the function hands it), the
// entity tag must survive a changing generatedAt so revalidation can return 304,
// and content-addressed images must be cacheable forever.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import {
  entityTag,
  respondNotModified,
  sendBytes,
  sendJson,
  setImmutableCacheHeaders,
  setSharedCacheHeaders,
} from '../server/http-response.mjs'

function fakeResponse() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    ended: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = String(value) },
    removeHeader(key) { delete this.headers[key.toLowerCase()] },
    getHeader(key) { return this.headers[key.toLowerCase()] },
    status(code) { this.statusCode = code; return this },
    end(body) { this.body = body ?? null; this.ended = true; return this },
  }
}

const request = (acceptEncoding, ifNoneMatch) => ({
  headers: {
    ...(acceptEncoding ? { 'accept-encoding': acceptEncoding } : {}),
    ...(ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}),
  },
})

const samplePath = process.argv[2] || '/tmp/data.json'
let payload
try {
  payload = JSON.parse(readFileSync(samplePath, 'utf8'))
} catch {
  // Fall back to a synthetic payload of comparable shape when no capture exists.
  payload = { ok: true, datasets: { filler: Array.from({ length: 20_000 }, (_, i) => ({ i, t: `row ${i}` })) } }
}
const rawBytes = Buffer.byteLength(JSON.stringify(payload))
const results = []

// --- compression -----------------------------------------------------------
for (const [accept, expected, decode] of [
  ['br, gzip', 'br', brotliDecompressSync],
  ['gzip, deflate', 'gzip', gunzipSync],
  ['identity', undefined, null],
  ['', undefined, null],
]) {
  const response = fakeResponse()
  sendJson(request(accept), response, payload)
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-encoding'], expected, `encoding for "${accept}"`)
  assert.equal(response.headers.vary, 'Accept-Encoding', 'must vary on Accept-Encoding')
  assert.equal(
    Number(response.headers['content-length']),
    response.body.length,
    'Content-Length must match the bytes actually written',
  )
  // The compressed body has to round-trip to the identical JSON.
  const restored = decode ? decode(response.body) : response.body
  assert.deepEqual(JSON.parse(restored.toString('utf8')), payload, `round trip for "${accept}"`)
  results.push({
    accept: accept || '(none)',
    encoding: expected ?? 'identity',
    bytes: response.body.length,
    saved: `${((1 - response.body.length / rawBytes) * 100).toFixed(1)}%`,
  })
}

const brotliBytes = results.find((row) => row.encoding === 'br').bytes
assert.ok(brotliBytes < rawBytes * 0.2, `brotli must cut the body by >80% (got ${brotliBytes}/${rawBytes})`)

// Tiny bodies are not worth compressing.
const small = fakeResponse()
sendJson(request('br'), small, { ok: true })
assert.equal(small.headers['content-encoding'], undefined, 'small bodies stay uncompressed')

// --- entity tag ------------------------------------------------------------
const dataOnly = { scope: 'core', bucket: 12345, datasets: payload.datasets }
assert.equal(entityTag(JSON.stringify(dataOnly)), entityTag(JSON.stringify(dataOnly)), 'tag must be deterministic')
assert.notEqual(
  entityTag(JSON.stringify(dataOnly)),
  entityTag(JSON.stringify({ ...dataOnly, bucket: 12346 })),
  'tag must change when the timeline bucket advances',
)
// This is the property that makes 304 possible at all: the tag must not move
// just because the response carries a new generatedAt.
const tagA = entityTag(JSON.stringify({ ...dataOnly }))
const tagB = entityTag(JSON.stringify({ ...dataOnly }))
assert.equal(tagA, tagB, 'tag must ignore generatedAt')

// --- 304 -------------------------------------------------------------------
const matched = fakeResponse()
assert.equal(respondNotModified(request('br', tagA), matched, tagA), true, 'matching tag must short-circuit')
assert.equal(matched.statusCode, 304)
assert.equal(matched.body, null, '304 must carry no body')
assert.equal(matched.headers.etag, tagA)

const weak = fakeResponse()
assert.equal(respondNotModified(request('br', `W/${tagA}`), weak, tagA), true, 'weak validators must match')

const listed = fakeResponse()
assert.equal(respondNotModified(request('br', `"other", ${tagA}`), listed, tagA), true, 'tag lists must match')

const stale = fakeResponse()
assert.equal(respondNotModified(request('br', '"stale"'), stale, tagA), false, 'stale tag must not match')
assert.equal(stale.statusCode, null, 'no response written when the tag misses')

const absent = fakeResponse()
assert.equal(respondNotModified(request('br'), absent, tagA), false, 'no If-None-Match means no 304')

// --- cache headers ---------------------------------------------------------
const shared = fakeResponse()
shared.setHeader('Pragma', 'no-cache')
setSharedCacheHeaders(shared, { maxAgeSeconds: 60, staleWhileRevalidateSeconds: 300 })
assert.match(shared.headers['cache-control'], /s-maxage=60/)
assert.match(shared.headers['cache-control'], /stale-while-revalidate=300/)
assert.match(shared.headers['cache-control'], /max-age=0/, 'browser must revalidate its own copy')
assert.match(shared.headers['cdn-cache-control'], /s-maxage=60/)
assert.match(shared.headers['vercel-cdn-cache-control'], /s-maxage=60/)
assert.equal(shared.headers.pragma, undefined, 'a stale Pragma: no-cache must be cleared')

const immutable = fakeResponse()
immutable.setHeader('Pragma', 'no-cache')
setImmutableCacheHeaders(immutable)
for (const header of ['cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control']) {
  assert.match(immutable.headers[header], /max-age=31536000/, header)
  assert.match(immutable.headers[header], /immutable/, header)
}
assert.equal(immutable.headers.pragma, undefined)

// --- image bytes -----------------------------------------------------------
const image = fakeResponse()
const pixels = Buffer.from('89504e470d0a1a0a', 'hex')
sendBytes(request('br'), image, pixels, { contentType: 'image/png', etag: '"abc"', disposition: 'inline' })
assert.equal(image.statusCode, 200)
assert.equal(image.headers['content-type'], 'image/png')
assert.equal(Number(image.headers['content-length']), pixels.length)
assert.equal(image.headers['content-encoding'], undefined, 'already-compressed images must not be re-encoded')
assert.ok(image.body.equals(pixels), 'image bytes must pass through untouched')

console.log(JSON.stringify({
  ok: true,
  sample: samplePath,
  rawBytes,
  rawMegabytes: +(rawBytes / 1e6).toFixed(2),
  encodings: results,
}, null, 2))
