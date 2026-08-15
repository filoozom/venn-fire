import { neon } from '@neondatabase/serverless'

export const FLIGHT_HISTORY_START = '2026-08-14T11:00:00.000Z'
export const FLIGHT_HISTORY_LIMIT = 50_000

const schemaPromises = new WeakMap()
const databaseQueries = new Map()

export function flightDatabaseUrl(environment = process.env) {
  return environment.DATABASE_URL?.trim()
    || environment.POSTGRES_URL?.trim()
    || ''
}

export function flightObservationKey(observation) {
  return [
    String(observation.icao24 || '').toLowerCase(),
    new Date(observation.observedAt).toISOString(),
    Number(observation.latitude),
    Number(observation.longitude),
  ].join('|')
}

function validObservation(observation) {
  return observation
    && /^[0-9a-f]{6}$/i.test(String(observation.icao24 || ''))
    && Number.isFinite(Date.parse(observation.observedAt))
    && Number.isFinite(Number(observation.latitude))
    && Number.isFinite(Number(observation.longitude))
}

function optionalNumber(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function databaseQuery(databaseUrl) {
  if (!databaseQueries.has(databaseUrl)) {
    const sql = neon(databaseUrl)
    databaseQueries.set(databaseUrl, (text, parameters = []) => sql.query(text, parameters))
  }
  return databaseQueries.get(databaseUrl)
}

async function ensureSchema(query) {
  if (!schemaPromises.has(query)) {
    const promise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS flight_import_runs (
          bucket_at timestamptz PRIMARY KEY,
          polled_at timestamptz NOT NULL,
          sources jsonb NOT NULL DEFAULT '[]'::jsonb,
          conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
          received_observation_count integer NOT NULL DEFAULT 0,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await query(`
        CREATE TABLE IF NOT EXISTS flight_observations (
          observation_key text PRIMARY KEY,
          icao24 text NOT NULL,
          callsign text,
          registration text,
          observed_at timestamptz NOT NULL,
          latitude double precision NOT NULL,
          longitude double precision NOT NULL,
          altitude_ft double precision,
          ground_speed_kt double precision,
          track_degrees double precision,
          distance_drossart_km double precision,
          update_type text,
          provider_id text,
          provider_name text,
          provider_url text,
          corroborated_by jsonb NOT NULL DEFAULT '[]'::jsonb,
          source_data jsonb NOT NULL,
          first_ingested_at timestamptz NOT NULL DEFAULT now(),
          last_ingested_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await query(`
        CREATE INDEX IF NOT EXISTS flight_observations_observed_at_idx
        ON flight_observations (observed_at DESC)
      `)
    })()
    schemaPromises.set(query, promise)
    promise.catch(() => schemaPromises.delete(query))
  }
  await schemaPromises.get(query)
}

function observationRecord(observation) {
  return {
    observation_key: flightObservationKey(observation),
    icao24: String(observation.icao24).toLowerCase(),
    callsign: observation.callSign || null,
    registration: observation.registration || null,
    observed_at: new Date(observation.observedAt).toISOString(),
    latitude: Number(observation.latitude),
    longitude: Number(observation.longitude),
    altitude_ft: optionalNumber(observation.altitudeFt),
    ground_speed_kt: optionalNumber(observation.groundSpeedKt),
    track_degrees: optionalNumber(observation.trackDegrees),
    distance_drossart_km: optionalNumber(observation.distanceDrossartKm),
    update_type: observation.updateType || null,
    provider_id: observation.providerId || null,
    provider_name: observation.providerName || null,
    provider_url: observation.providerUrl || null,
    corroborated_by: Array.isArray(observation.corroboratedBy) ? observation.corroboratedBy : [],
    source_data: observation,
  }
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value)
  return date.toISOString()
}

function storedObservation(row) {
  return {
    icao24: row.icao24,
    callSign: row.callsign,
    registration: row.registration,
    observedAt: isoTimestamp(row.observed_at),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    altitudeFt: row.altitude_ft == null ? null : Number(row.altitude_ft),
    groundSpeedKt: row.ground_speed_kt == null ? null : Number(row.ground_speed_kt),
    trackDegrees: row.track_degrees == null ? null : Number(row.track_degrees),
    distanceDrossartKm: row.distance_drossart_km == null ? null : Number(row.distance_drossart_km),
    updateType: row.update_type,
    providerId: row.provider_id,
    providerName: row.provider_name,
    providerUrl: row.provider_url,
    corroboratedBy: Array.isArray(row.corroborated_by) ? row.corroborated_by : [],
  }
}

export function mergeFlightHistory(history, live) {
  const byKey = new Map()
  for (const observation of [...history, ...live]) {
    if (!validObservation(observation)) continue
    const key = flightObservationKey(observation)
    const previous = byKey.get(key)
    if (!previous) {
      byKey.set(key, observation)
      continue
    }
    const providers = new Set([
      previous.providerId,
      ...(previous.corroboratedBy || []),
      observation.providerId,
      ...(observation.corroboratedBy || []),
    ].filter(Boolean))
    providers.delete(observation.providerId)
    byKey.set(key, { ...previous, ...observation, corroboratedBy: [...providers].sort() })
  }
  return [...byKey.values()].sort((left, right) => (
    Date.parse(left.observedAt) - Date.parse(right.observedAt)
      || left.icao24.localeCompare(right.icao24)
  ))
}

export async function loadFlightHistory({
  databaseUrl = flightDatabaseUrl(),
  query = databaseUrl ? databaseQuery(databaseUrl) : null,
  since = FLIGHT_HISTORY_START,
  limit = FLIGHT_HISTORY_LIMIT,
} = {}) {
  if (!databaseUrl && !query) {
    return { configured: false, ok: false, observations: [] }
  }
  await ensureSchema(query)
  const rows = await query(`
    SELECT * FROM (
      SELECT
        icao24, callsign, registration, observed_at, latitude, longitude,
        altitude_ft, ground_speed_kt, track_degrees, distance_drossart_km,
        update_type, provider_id, provider_name, provider_url, corroborated_by
      FROM flight_observations
      WHERE observed_at >= $1::timestamptz
      ORDER BY observed_at DESC
      LIMIT $2
    ) AS recent_history
    ORDER BY observed_at ASC
  `, [since, limit])
  return {
    configured: true,
    ok: true,
    observations: rows.map(storedObservation),
  }
}

async function upsertFlightObservations(observations, query) {
  const records = observations.filter(validObservation).map(observationRecord)
  if (!records.length) return 0

  const persisted = await query(`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
        observation_key text,
        icao24 text,
        callsign text,
        registration text,
        observed_at timestamptz,
        latitude double precision,
        longitude double precision,
        altitude_ft double precision,
        ground_speed_kt double precision,
        track_degrees double precision,
        distance_drossart_km double precision,
        update_type text,
        provider_id text,
        provider_name text,
        provider_url text,
        corroborated_by jsonb,
        source_data jsonb
      )
    )
    INSERT INTO flight_observations (
      observation_key, icao24, callsign, registration, observed_at,
      latitude, longitude, altitude_ft, ground_speed_kt, track_degrees,
      distance_drossart_km, update_type, provider_id, provider_name,
      provider_url, corroborated_by, source_data
    )
    SELECT
      observation_key, icao24, callsign, registration, observed_at,
      latitude, longitude, altitude_ft, ground_speed_kt, track_degrees,
      distance_drossart_km, update_type, provider_id, provider_name,
      provider_url, corroborated_by, source_data
    FROM incoming
    ON CONFLICT (observation_key) DO UPDATE SET
      callsign = COALESCE(EXCLUDED.callsign, flight_observations.callsign),
      registration = COALESCE(EXCLUDED.registration, flight_observations.registration),
      altitude_ft = COALESCE(EXCLUDED.altitude_ft, flight_observations.altitude_ft),
      ground_speed_kt = COALESCE(EXCLUDED.ground_speed_kt, flight_observations.ground_speed_kt),
      track_degrees = COALESCE(EXCLUDED.track_degrees, flight_observations.track_degrees),
      provider_id = COALESCE(EXCLUDED.provider_id, flight_observations.provider_id),
      provider_name = COALESCE(EXCLUDED.provider_name, flight_observations.provider_name),
      provider_url = COALESCE(EXCLUDED.provider_url, flight_observations.provider_url),
      corroborated_by = EXCLUDED.corroborated_by,
      source_data = EXCLUDED.source_data,
      last_ingested_at = now()
    RETURNING observation_key
  `, [JSON.stringify(records)])
  return persisted.length
}

export async function persistFlightObservations({ observations = [] }, {
  databaseUrl = flightDatabaseUrl(),
  query = databaseUrl ? databaseQuery(databaseUrl) : null,
  since = FLIGHT_HISTORY_START,
  limit = FLIGHT_HISTORY_LIMIT,
} = {}) {
  if (!databaseUrl && !query) {
    return { configured: false, ok: false, persistedObservations: 0, observations: [] }
  }
  await ensureSchema(query)
  const persistedObservations = await upsertFlightObservations(observations, query)
  const history = await loadFlightHistory({ databaseUrl, query, since, limit })
  return {
    configured: true,
    ok: true,
    persistedObservations,
    observations: history.observations,
  }
}

export async function persistFlightPoll({
  generatedAt,
  observations = [],
  sources = [],
  conflicts = [],
}, {
  databaseUrl = flightDatabaseUrl(),
  query = databaseUrl ? databaseQuery(databaseUrl) : null,
  since = FLIGHT_HISTORY_START,
  limit = FLIGHT_HISTORY_LIMIT,
} = {}) {
  if (!databaseUrl && !query) {
    return { configured: false, ok: false, persistedObservations: 0, observations: [] }
  }

  await ensureSchema(query)
  const polledAtMs = Date.parse(generatedAt)
  if (!Number.isFinite(polledAtMs)) throw new Error('Flight poll generatedAt must be an ISO-8601 timestamp')
  const bucketAt = new Date(Math.floor(polledAtMs / (5 * 60 * 1_000)) * 5 * 60 * 1_000).toISOString()
  const records = observations.filter(validObservation).map(observationRecord)

  await query(`
    INSERT INTO flight_import_runs (
      bucket_at, polled_at, sources, conflicts, received_observation_count
    ) VALUES ($1::timestamptz, $2::timestamptz, $3::jsonb, $4::jsonb, $5)
    ON CONFLICT (bucket_at) DO UPDATE SET
      polled_at = GREATEST(flight_import_runs.polled_at, EXCLUDED.polled_at),
      sources = EXCLUDED.sources,
      conflicts = EXCLUDED.conflicts,
      received_observation_count = GREATEST(
        flight_import_runs.received_observation_count,
        EXCLUDED.received_observation_count
      ),
      updated_at = now()
  `, [bucketAt, generatedAt, JSON.stringify(sources), JSON.stringify(conflicts), records.length])

  const persistedObservations = await upsertFlightObservations(observations, query)

  const history = await loadFlightHistory({ databaseUrl, query, since, limit })
  return {
    configured: true,
    ok: true,
    bucketAt,
    persistedObservations,
    observations: history.observations,
  }
}
