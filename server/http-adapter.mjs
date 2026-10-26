// Supply parsed query parameters and status()/json() helpers to API handlers
// running on Node's HTTP server.

function parsedQuery(requestUrl) {
  const { searchParams } = new URL(requestUrl ?? '/', 'http://localhost')
  const query = Object.create(null)
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key)
    // Keep repeated parameters as arrays; handlers defend against both forms.
    query[key] = values.length > 1 ? values : values[0]
  }
  return query
}

export function withHttpHelpers(handler) {
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
