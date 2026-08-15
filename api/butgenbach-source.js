export const config = { runtime: 'edge' }

const FIVE_MINUTE_BUCKET_MS = 5 * 60 * 1000
const SOURCE_ORIGIN = 'https://butgenbach.be'

function responseHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'Cache-Control': 'no-store, max-age=0',
    'CDN-Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Content-Type': contentType,
  }
}

function errorResponse(status, error) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: responseHeaders(),
  })
}

function allowedPath(value) {
  if (value === '/wp-sitemap-posts-post-1.xml') return value
  return /^\/[a-z0-9][a-z0-9-]{1,180}\/$/u.test(value) ? value : null
}

function bytesFromHex(value) {
  if (!/^[a-f0-9]{64}$/iu.test(value)) return null
  return Uint8Array.from(value.match(/../gu), (byte) => Number.parseInt(byte, 16))
}

async function validSignature({ path, timestamp, signature, secret }) {
  const timestampBucket = Number(timestamp)
  if (!Number.isSafeInteger(timestampBucket)) return false
  const currentBucket = Math.floor(Date.now() / FIVE_MINUTE_BUCKET_MS)
  if (Math.abs(currentBucket - timestampBucket) > 1) return false
  const signatureBytes = bytesFromHex(signature)
  if (!signatureBytes) return false

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    encoder.encode(`${timestampBucket}\n${path}`),
  )
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: responseHeaders() })
  }
  if (request.method !== 'GET') return errorResponse(405, 'Method not allowed')

  const secret = process.env.INTERNAL_SOURCE_TOKEN?.trim()
  if (!secret) return errorResponse(503, 'Internal source token is not configured')

  const requestUrl = new URL(request.url)
  const path = allowedPath(requestUrl.searchParams.get('path') || '')
  const timestamp = request.headers.get('x-venn-timestamp') || ''
  const signature = request.headers.get('x-venn-signature') || ''
  if (!path || !await validSignature({ path, timestamp, signature, secret })) {
    return errorResponse(401, 'Invalid source request')
  }

  try {
    const upstream = await fetch(`${SOURCE_ORIGIN}${path}`, {
      headers: {
        Accept: path.endsWith('.xml') ? 'application/xml, text/xml' : 'text/html',
        'Accept-Language': 'de-BE,de;q=0.9,fr;q=0.7,en;q=0.5',
        'User-Agent': 'VennFireWatch/1.0 (+https://venn-fire.vercel.app)',
      },
      redirect: 'follow',
    })
    const body = await upstream.arrayBuffer()
    return new Response(body, {
      status: upstream.status,
      headers: responseHeaders(
        upstream.headers.get('content-type')?.split(';')[0]
          || (path.endsWith('.xml') ? 'application/xml' : 'text/html'),
      ),
    })
  } catch {
    return errorResponse(502, 'Official source fetch failed')
  }
}
