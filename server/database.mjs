import { createHash } from 'node:crypto'

import { neon } from '@neondatabase/serverless'

const databaseQueries = new Map()
const schemaPromises = new WeakMap()

export function databaseUrl(environment = process.env) {
  return environment.DATABASE_URL?.trim()
    || environment.POSTGRES_URL?.trim()
    || ''
}

export function databaseQuery(url = databaseUrl()) {
  if (!url) throw new Error('DATABASE_URL or POSTGRES_URL is required')
  if (!databaseQueries.has(url)) {
    const sql = neon(url)
    databaseQueries.set(url, (text, parameters = []) => sql.query(text, parameters))
  }
  return databaseQueries.get(url)
}

const VOLATILE_VERSION_KEYS = new Set([
  'generatedAt',
  'lastRetrievedAt',
  'refreshedAt',
  'retrievedAt',
])

function semanticPayload(value) {
  if (Array.isArray(value)) return value.map(semanticPayload)
  if (value == null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE_VERSION_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, semanticPayload(nested)]),
  )
}

export function payloadHash(payload) {
  return createHash('sha256').update(JSON.stringify(semanticPayload(payload))).digest('hex')
}

export async function ensureDatabaseSchema(query = databaseQuery()) {
  if (!schemaPromises.has(query)) {
    const promise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS app_datasets (
          dataset_key text PRIMARY KEY,
          schema_version integer NOT NULL DEFAULT 1,
          payload jsonb NOT NULL,
          content_hash text NOT NULL,
          source_updated_at timestamptz,
          refreshed_at timestamptz NOT NULL DEFAULT now(),
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await query(`
        CREATE TABLE IF NOT EXISTS app_dataset_versions (
          dataset_key text NOT NULL,
          content_hash text NOT NULL,
          schema_version integer NOT NULL DEFAULT 1,
          payload jsonb NOT NULL,
          source_updated_at timestamptz,
          captured_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (dataset_key, content_hash)
        )
      `)
      await query(`
        CREATE INDEX IF NOT EXISTS app_dataset_versions_captured_at_idx
        ON app_dataset_versions (dataset_key, captured_at DESC)
      `)
      await query(`
        CREATE TABLE IF NOT EXISTS source_refresh_runs (
          source_key text NOT NULL,
          bucket_at timestamptz NOT NULL,
          interval_minutes integer NOT NULL,
          status text NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
          started_at timestamptz NOT NULL DEFAULT now(),
          completed_at timestamptz,
          error text,
          item_count integer,
          metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
          PRIMARY KEY (source_key, bucket_at)
        )
      `)
      await query(`
        CREATE INDEX IF NOT EXISTS source_refresh_runs_started_at_idx
        ON source_refresh_runs (started_at DESC)
      `)
      await query(`
        CREATE TABLE IF NOT EXISTS refresh_scheduler_ticks (
          deployment_id text NOT NULL,
          scheduled_for timestamptz NOT NULL,
          status text NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
          message_id text,
          started_at timestamptz NOT NULL DEFAULT now(),
          completed_at timestamptz,
          error text,
          metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
          PRIMARY KEY (deployment_id, scheduled_for)
        )
      `)
      await query(`
        CREATE INDEX IF NOT EXISTS refresh_scheduler_ticks_started_at_idx
        ON refresh_scheduler_ticks (started_at DESC)
      `)
      await query(`
        CREATE TABLE IF NOT EXISTS source_artifacts (
          artifact_key text PRIMARY KEY,
          source_key text NOT NULL,
          original_path text NOT NULL,
          content_type text NOT NULL,
          content_encoding text NOT NULL,
          original_size bigint NOT NULL,
          sha256 text NOT NULL,
          captured_at timestamptz,
          content bytea NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await query(`
        CREATE INDEX IF NOT EXISTS source_artifacts_source_idx
        ON source_artifacts (source_key, captured_at DESC)
      `)
    })()
    schemaPromises.set(query, promise)
    promise.catch(() => schemaPromises.delete(query))
  }
  await schemaPromises.get(query)
}

export async function saveDataset({
  key,
  payload,
  schemaVersion = Number(payload?.schemaVersion) || 1,
  sourceUpdatedAt = payload?.generatedAt || payload?.retrievedAt || null,
}, query = databaseQuery()) {
  if (!key || typeof key !== 'string') throw new Error('Dataset key is required')
  if (payload == null || typeof payload !== 'object') throw new Error(`Dataset ${key} must be an object or array`)
  await ensureDatabaseSchema(query)
  const hash = payloadHash(payload)
  const json = JSON.stringify(payload)
  const versionRows = await query(`
    INSERT INTO app_dataset_versions (
      dataset_key, content_hash, schema_version, payload, source_updated_at
    ) VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
    ON CONFLICT (dataset_key, content_hash) DO NOTHING
    RETURNING content_hash
  `, [key, hash, schemaVersion, json, sourceUpdatedAt])
  await query(`
    INSERT INTO app_datasets (
      dataset_key, schema_version, payload, content_hash, source_updated_at, refreshed_at
    ) VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz, now())
    ON CONFLICT (dataset_key) DO UPDATE SET
      schema_version = EXCLUDED.schema_version,
      payload = EXCLUDED.payload,
      content_hash = EXCLUDED.content_hash,
      source_updated_at = EXCLUDED.source_updated_at,
      refreshed_at = now()
  `, [key, schemaVersion, json, hash, sourceUpdatedAt])
  return { key, hash, changed: versionRows.length > 0 }
}

export async function loadDatasets(query = databaseQuery()) {
  await ensureDatabaseSchema(query)
  const rows = await query(`
    SELECT dataset_key, schema_version, payload, content_hash,
           source_updated_at, refreshed_at
    FROM app_datasets
    ORDER BY dataset_key
  `)
  return Object.fromEntries(rows.map((row) => [row.dataset_key, {
    schemaVersion: row.schema_version,
    payload: row.payload,
    contentHash: row.content_hash,
    sourceUpdatedAt: row.source_updated_at == null ? null : new Date(row.source_updated_at).toISOString(),
    refreshedAt: new Date(row.refreshed_at).toISOString(),
  }]))
}

export async function loadDataset(key, query = databaseQuery()) {
  await ensureDatabaseSchema(query)
  const rows = await query(`
    SELECT dataset_key, schema_version, payload, content_hash,
           source_updated_at, refreshed_at
    FROM app_datasets
    WHERE dataset_key = $1
  `, [key])
  if (!rows[0]) return null
  return {
    key: rows[0].dataset_key,
    schemaVersion: rows[0].schema_version,
    payload: rows[0].payload,
    contentHash: rows[0].content_hash,
    sourceUpdatedAt: rows[0].source_updated_at == null ? null : new Date(rows[0].source_updated_at).toISOString(),
    refreshedAt: new Date(rows[0].refreshed_at).toISOString(),
  }
}

function refreshBucketAt(requestedAtMs, intervalMinutes) {
  const intervalMs = intervalMinutes * 60_000
  return new Date(Math.floor(requestedAtMs / intervalMs) * intervalMs).toISOString()
}

export async function claimSourceRefresh({
  sourceKey,
  intervalMinutes,
  requestedAtMs = Date.now(),
}, query = databaseQuery()) {
  if (!sourceKey || !Number.isInteger(intervalMinutes) || intervalMinutes < 5) {
    throw new Error('A source key and interval of at least five minutes are required')
  }
  await ensureDatabaseSchema(query)
  const bucketAt = refreshBucketAt(requestedAtMs, intervalMinutes)
  const rows = await query(`
    INSERT INTO source_refresh_runs (
      source_key, bucket_at, interval_minutes, status, started_at
    ) VALUES ($1, $2::timestamptz, $3, 'running', now())
    ON CONFLICT (source_key, bucket_at) DO UPDATE SET
      status = 'running',
      started_at = now(),
      completed_at = NULL,
      error = NULL,
      item_count = NULL,
      metadata = '{}'::jsonb
    WHERE source_refresh_runs.status = 'failed'
       OR (source_refresh_runs.status = 'running'
           AND source_refresh_runs.started_at < now() - interval '4 minutes')
    RETURNING source_key, bucket_at
  `, [sourceKey, bucketAt, intervalMinutes])
  return { claimed: rows.length > 0, bucketAt }
}

export async function completeSourceRefresh({
  sourceKey,
  bucketAt,
  itemCount = null,
  metadata = {},
}, query = databaseQuery()) {
  await query(`
    UPDATE source_refresh_runs
    SET status = 'ok', completed_at = now(), error = NULL,
        item_count = $3, metadata = $4::jsonb
    WHERE source_key = $1 AND bucket_at = $2::timestamptz
  `, [sourceKey, bucketAt, itemCount, JSON.stringify(metadata)])
}

export async function failSourceRefresh({ sourceKey, bucketAt, error }, query = databaseQuery()) {
  const message = String(error?.message ?? error ?? 'Unknown refresh failure').slice(0, 2_000)
  await query(`
    UPDATE source_refresh_runs
    SET status = 'failed', completed_at = now(), error = $3
    WHERE source_key = $1 AND bucket_at = $2::timestamptz
  `, [sourceKey, bucketAt, message])
}

export async function saveArtifact({
  artifactKey,
  sourceKey,
  originalPath,
  contentType = 'application/octet-stream',
  contentEncoding = 'gzip',
  originalSize,
  sha256,
  capturedAt = null,
  contentBase64,
}, query = databaseQuery()) {
  await ensureDatabaseSchema(query)
  await query(`
    INSERT INTO source_artifacts (
      artifact_key, source_key, original_path, content_type, content_encoding,
      original_size, sha256, captured_at, content
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, decode($9, 'base64')
    )
    ON CONFLICT (artifact_key) DO UPDATE SET
      source_key = EXCLUDED.source_key,
      original_path = EXCLUDED.original_path,
      content_type = EXCLUDED.content_type,
      content_encoding = EXCLUDED.content_encoding,
      original_size = EXCLUDED.original_size,
      sha256 = EXCLUDED.sha256,
      captured_at = EXCLUDED.captured_at,
      content = EXCLUDED.content
  `, [
    artifactKey,
    sourceKey,
    originalPath,
    contentType,
    contentEncoding,
    originalSize,
    sha256,
    capturedAt,
    contentBase64,
  ])
  return { artifactKey }
}

export async function loadArtifact(artifactKey, query = databaseQuery()) {
  await ensureDatabaseSchema(query)
  const rows = await query(`
    SELECT artifact_key, source_key, original_path, content_type,
           content_encoding, original_size, sha256, captured_at,
           encode(content, 'base64') AS content_base64
    FROM source_artifacts
    WHERE artifact_key = $1
  `, [artifactKey])
  if (!rows[0]) return null
  return {
    artifactKey: rows[0].artifact_key,
    sourceKey: rows[0].source_key,
    originalPath: rows[0].original_path,
    contentType: rows[0].content_type,
    contentEncoding: rows[0].content_encoding,
    originalSize: Number(rows[0].original_size),
    sha256: rows[0].sha256,
    capturedAt: rows[0].captured_at == null ? null : new Date(rows[0].captured_at).toISOString(),
    contentBase64: rows[0].content_base64,
  }
}

export async function databaseOverview(query = databaseQuery()) {
  await ensureDatabaseSchema(query)
  const [datasets, versions, artifacts, artifactBytes, sources] = await Promise.all([
    query('SELECT count(*)::integer AS count FROM app_datasets'),
    query('SELECT count(*)::integer AS count FROM app_dataset_versions'),
    query('SELECT count(*)::integer AS count FROM source_artifacts'),
    query('SELECT COALESCE(sum(original_size), 0)::bigint::text AS bytes FROM source_artifacts'),
    query(`
      SELECT DISTINCT ON (source_key)
        source_key, bucket_at, interval_minutes, status, started_at,
        completed_at, error, item_count, metadata
      FROM source_refresh_runs
      ORDER BY source_key, bucket_at DESC
    `),
  ])
  return {
    datasetCount: datasets[0].count,
    datasetVersionCount: versions[0].count,
    artifactCount: artifacts[0].count,
    artifactOriginalBytes: Number(artifactBytes[0].bytes),
    sources: sources.map((row) => ({
      sourceKey: row.source_key,
      bucketAt: new Date(row.bucket_at).toISOString(),
      intervalMinutes: row.interval_minutes,
      status: row.status,
      startedAt: new Date(row.started_at).toISOString(),
      completedAt: row.completed_at == null ? null : new Date(row.completed_at).toISOString(),
      error: row.error,
      itemCount: row.item_count,
      metadata: row.metadata,
    })),
  }
}

export function setNoStoreHeaders(response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0')
  response.setHeader('CDN-Cache-Control', 'no-store')
  response.setHeader('Vercel-CDN-Cache-Control', 'no-store')
  response.setHeader('Pragma', 'no-cache')
}
