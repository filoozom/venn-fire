import handler from '../api/live-situation.js'

let statusCode = null
let headers = {}
let body = null

const response = {
  setHeader(name, value) {
    headers[name.toLowerCase()] = value
  },
  status(code) {
    statusCode = code
    return this
  },
  json(value) {
    body = value
    return value
  },
  end() {},
}

await handler({ method: 'GET' }, response)

if (statusCode !== 200) throw new Error(`Expected HTTP 200, got ${statusCode}`)
if (!body?.generatedAt) throw new Error('Live endpoint omitted generatedAt')
if (!body.weather?.ok || !body.weather.rows?.length) throw new Error('Open-Meteo live refresh failed')
if (!body.aircraft?.ok) throw new Error('Both live ADS-B provider requests failed')
if (typeof body.aircraft.persistence?.configured !== 'boolean') throw new Error('Live endpoint omitted flight-history status')
if (body.aircraft.persistence.configured && !body.aircraft.persistence.ok) throw new Error('Configured flight history is unavailable')
if (!body.reports?.ok || !body.reports.complete) throw new Error('Governor/BRF live report refresh was not complete')
if (!body.reports.areaReports?.length) throw new Error('Live endpoint returned no timestamped area reports')
if (body.refreshAfterSeconds !== 300) throw new Error('Live flight refresh is not configured for five minutes')
if (!String(headers['cache-control']).includes('s-maxage=300')) throw new Error('Live endpoint cache policy is not five minutes')

for (const observation of body.aircraft.observations) {
  if (!['44c1e5', '44c1e8', '44c1ea'].includes(observation.icao24)) {
    throw new Error(`Unexpected incident-aircraft hex ${observation.icao24}`)
  }
  if (observation.distanceDrossartKm > 10) {
    throw new Error(`Live observation escaped incident radius: ${observation.distanceDrossartKm} km`)
  }
}

const allowedReportSources = new Set(['Governor of Liège', 'BRF'])
for (const report of body.reports.areaReports) {
  if (!allowedReportSources.has(report.source)) throw new Error(`Unexpected live area-report source ${report.source}`)
  if (!Number.isFinite(report.timestampMs) || !Number.isFinite(report.reportedHa)) {
    throw new Error(`Malformed timestamped area report: ${JSON.stringify(report)}`)
  }
}
if (!body.reports.areaReports.some((report) => report.source === 'Governor of Liège' && report.reportedHa === 850)) {
  throw new Error('Governor 07:00 estimate was not recovered from the official page')
}
if (!body.reports.areaReports.some((report) => report.source === 'BRF' && report.reportedHa >= 1500)) {
  throw new Error('BRF current estimate was not recovered from its incident page')
}

console.log(JSON.stringify({
  statusCode,
  generatedAt: body.generatedAt,
  weatherRows: body.weather.rows.length,
  currentWeather: body.weather.current,
  aircraftObservations: body.aircraft.observations,
  aircraftConflicts: body.aircraft.conflicts,
  aircraftSources: body.aircraft.sources,
  aircraftPersistence: body.aircraft.persistence,
  areaReports: body.reports.areaReports,
  reportSources: body.reports.sources,
  cacheControl: headers['cache-control'],
}, null, 2))
