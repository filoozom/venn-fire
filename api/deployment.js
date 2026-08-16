function noStore(response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0')
  response.setHeader('CDN-Cache-Control', 'no-store')
  response.setHeader('Vercel-CDN-Cache-Control', 'no-store')
  response.setHeader('Pragma', 'no-cache')
}

export default function handler(request, response) {
  noStore(response)
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (request.method === 'OPTIONS') return response.status(204).end()
  if (request.method !== 'GET') return response.status(405).json({ ok: false, error: 'Method not allowed' })

  return response.status(200).json({
    ok: true,
    deployment: {
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID?.trim() || null,
      gitCommitSha: process.env.VERCEL_GIT_COMMIT_SHA?.trim() || null,
    },
  })
}
