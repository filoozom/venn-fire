// The API handlers are written against Vercel's Node runtime, which pre-parses
// the query string onto request.query and adds Express-style status()/json()
// helpers to the response. Node's own http server provides neither, so this
// adapter supplies exactly those pieces and nothing else. It lets the same
// handler files serve both Vercel and the self-hosted server without forking.

function parsedQuery(requestUrl) {
  const { searchParams } = new URL(requestUrl ?? '/', 'http://localhost')
  const query = Object.create(null)
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key)
    // Vercel collapses a single occurrence to a string and keeps repeats as an
    // array; the handlers defend against both.
    query[key] = values.length > 1 ? values : values[0]
  }
  return query
}

export function withVercelRuntime(handler) {
  return async function adapted(request, response) {
    request.query ??= parsedQuery(request.url)

    response.status = (code) => {
      response.statusCode = code
      return response
    }

    response.json = (payload) => {
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      if (!response.hasHeader('Content-Type')) {
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
      }
      response.setHeader('Content-Length', String(body.length))
      response.end(body)
      return response
    }

    await handler(request, response)
  }
}
