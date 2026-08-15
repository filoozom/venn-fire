import { readFile } from 'node:fs/promises'
import path from 'node:path'

const SNAPSHOT_PATH = 'src/incidentAircraftSnapshot.json'
const AIRPLANES_14_PATH = '.local-data/airplanes-live/2026-08-14/observations.geojson'
const AIRPLANES_15_PATH = '.local-data/airplanes-live/2026-08-15/area-scan.json'
const ADSB_LOL_15_PATH = '.local-data/adsb-lol/2026-08-15/area-scan.json'
const INCIDENT_HEXES = new Set(['44c1e5', '44c1ea'])
const CENTER = [50.54762, 6.05757]

async function readJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'))
}

function haversineKm(left, right) {
  const radians = Math.PI / 180
  const deltaLatitude = (right[0] - left[0]) * radians
  const deltaLongitude = (right[1] - left[1]) * radians
  const value = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(left[0] * radians) * Math.cos(right[0] * radians) * Math.sin(deltaLongitude / 2) ** 2
  return 6371.0088 * 2 * Math.asin(Math.sqrt(value))
}

function observationKey(observedAt, latitude, longitude, altitudeFt) {
  return `${observedAt}|${latitude.toFixed(6)}|${longitude.toFixed(6)}|${altitudeFt}`
}

const [snapshot, airplanes14, airplanes15, adsbLol15] = await Promise.all([
  readJson(SNAPSHOT_PATH),
  readJson(AIRPLANES_14_PATH),
  readJson(AIRPLANES_15_PATH),
  readJson(ADSB_LOL_15_PATH),
])

const snapshotRows = snapshot.aircraft.flatMap((aircraft) => aircraft.observations.map((observation) => ({
  icao24: aircraft.icao24,
  observedAt: observation[0],
  latitude: observation[1],
  longitude: observation[2],
  altitudeFt: observation[3],
  sourceId: observation[4],
})))

const source14Rows = airplanes14.features
  .filter((feature) => feature.properties?.icao24 === '44c1e5' && feature.properties?.inside_search_area)
  .map((feature) => ({
    icao24: feature.properties.icao24,
    observedAt: feature.properties.observed_at,
    latitude: feature.geometry.coordinates[1],
    longitude: feature.geometry.coordinates[0],
    altitudeFt: feature.properties.altitude_ft,
  }))

const source15Rows = airplanes15.observations
  .filter((observation) => INCIDENT_HEXES.has(observation.hex))
  .filter((observation) => haversineKm(CENTER, [observation.lat, observation.lon]) <= snapshot.selection.maximumIncidentDistanceKm)
  .map((observation) => ({
    icao24: observation.hex,
    observedAt: observation.observedAt,
    latitude: observation.lat,
    longitude: observation.lon,
    altitudeFt: observation.altitude,
  }))

function assertExactSource(sourceRows, sourceId) {
  const expected = new Set(sourceRows.map((row) => `${row.icao24}|${observationKey(row.observedAt, row.latitude, row.longitude, row.altitudeFt)}`))
  const actual = new Set(snapshotRows
    .filter((row) => row.sourceId === sourceId)
    .map((row) => `${row.icao24}|${observationKey(row.observedAt, row.latitude, row.longitude, row.altitudeFt)}`))
  const missing = [...expected].filter((key) => !actual.has(key))
  const extra = [...actual].filter((key) => !expected.has(key))
  if (missing.length || extra.length) {
    throw new Error(`${sourceId} mismatch: ${missing.length} missing, ${extra.length} extra`)
  }
}

assertExactSource(source14Rows, 'airplanes-live-daily-2026-08-14')
assertExactSource(source15Rows, 'airplanes-live-replay-2026-08-15')

const outOfRadius = snapshotRows.filter((row) => (
  haversineKm(CENTER, [row.latitude, row.longitude]) > snapshot.selection.maximumIncidentDistanceKm
))
if (outOfRadius.length) throw new Error(`${outOfRadius.length} snapshot observations exceed the 10 km incident radius`)
if (snapshotRows.some((row) => row.latitude > 50.65)) {
  throw new Error('Known Aachen/Walheim false MLAT cluster leaked into the incident snapshot')
}

const adsbLolIncidentRows = adsbLol15.observations.filter((observation) => INCIDENT_HEXES.has(observation.hex))
if (adsbLolIncidentRows.length) {
  throw new Error(`Expected no ADSB.lol G10/G17 replay observations, found ${adsbLolIncidentRows.length}`)
}

const connectorAudit = {}
snapshot.aircraft.forEach((aircraft) => {
  const rows = aircraft.observations.map((observation) => ({
    observedAt: observation[0],
    timestampMs: Date.parse(observation[0]),
    position: [observation[1], observation[2]],
  }))
  let accepted = 0
  let rejectedGap = 0
  let rejectedSpeed = 0
  rows.slice(1).forEach((row, index) => {
    const previous = rows[index]
    const elapsedMs = row.timestampMs - previous.timestampMs
    if (elapsedMs <= 0 || elapsedMs > snapshot.selection.connectorMaximumGapSeconds * 1_000) {
      rejectedGap += 1
      return
    }
    const impliedSpeedKt = haversineKm(previous.position, row.position) / 1.852 / (elapsedMs / 3_600_000)
    if (impliedSpeedKt > snapshot.selection.connectorMaximumImpliedSpeedKt) {
      rejectedSpeed += 1
      return
    }
    accepted += 1
  })
  connectorAudit[aircraft.callSign] = { observations: rows.length, accepted, rejectedGap, rejectedSpeed }
})

console.log(JSON.stringify({
  snapshot: SNAPSHOT_PATH,
  exactSourceRows: { airplanesLive14: source14Rows.length, airplanesLive15: source15Rows.length },
  adsbLol15IncidentRows: adsbLolIncidentRows.length,
  connectorAudit,
}, null, 2))
