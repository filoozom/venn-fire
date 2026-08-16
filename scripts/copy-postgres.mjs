#!/usr/bin/env node

import {
  ensureDatabaseSchema,
  rebuildPublicDatasets,
} from '../server/database.mjs'
import { ensureFlightHistorySchema } from '../server/flight-history.mjs'
import { closePostgresPools, postgresPool, postgresUrl } from '../server/postgres.mjs'

const sourceUrl = process.env.SOURCE_DATABASE_URL?.trim() || ''
const targetUrl = process.env.TARGET_DATABASE_URL?.trim() || postgresUrl()

if (!sourceUrl || !targetUrl) {
  throw new Error('Set SOURCE_DATABASE_URL plus TARGET_DATABASE_URL or PGHOST/PGPASSWORD/PG_CA_PEM before copying PostgreSQL')
}
if (sourceUrl === targetUrl) throw new Error('Source and target PostgreSQL URLs must be different')

const TABLES = [
  { name: 'app_datasets', primaryKey: ['dataset_key'], batchSize: 100 },
  { name: 'app_dataset_versions', primaryKey: ['dataset_key', 'content_hash'], batchSize: 100 },
  { name: 'source_refresh_runs', primaryKey: ['source_key', 'bucket_at'], batchSize: 250 },
  { name: 'refresh_scheduler_ticks', primaryKey: ['deployment_id', 'scheduled_for'], batchSize: 250 },
  { name: 'source_artifacts', primaryKey: ['artifact_key'], batchSize: 10 },
  { name: 'flight_import_runs', primaryKey: ['bucket_at'], batchSize: 250 },
  { name: 'flight_observations', primaryKey: ['observation_key'], batchSize: 250 },
]

function identifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

async function tableColumns(query, tableName) {
  const rows = await query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName])
  if (!rows.length) throw new Error(`Source table ${tableName} is missing`)
  return rows.map((row) => row.column_name)
}

async function copyTable({ sourceQuery, targetQuery, name, primaryKey, batchSize }) {
  const columns = await tableColumns(sourceQuery, name)
  const targetColumns = await tableColumns(targetQuery, name)
  const missingTargetColumns = columns.filter((column) => !targetColumns.includes(column))
  if (missingTargetColumns.length) {
    throw new Error(`Target table ${name} is missing columns: ${missingTargetColumns.join(', ')}`)
  }

  const columnList = columns.map(identifier).join(', ')
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ')
  const updateColumns = columns.filter((column) => !primaryKey.includes(column))
  const conflict = updateColumns.length
    ? `DO UPDATE SET ${updateColumns.map((column) => `${identifier(column)} = EXCLUDED.${identifier(column)}`).join(', ')}`
    : 'DO NOTHING'
  const insertSql = `
    INSERT INTO ${identifier(name)} (${columnList})
    VALUES (${placeholders})
    ON CONFLICT (${primaryKey.map(identifier).join(', ')}) ${conflict}
  `

  let copied = 0
  while (true) {
    const rows = await sourceQuery(`
      SELECT ${columnList}
      FROM ${identifier(name)}
      ORDER BY ${primaryKey.map(identifier).join(', ')}
      LIMIT $1 OFFSET $2
    `, [batchSize, copied])
    if (!rows.length) break
    for (const row of rows) {
      await targetQuery(insertSql, columns.map((column) => row[column]))
    }
    copied += rows.length
    console.log(`${name}: ${copied} rows copied`)
    if (rows.length < batchSize) break
  }

  const [sourceCount] = await sourceQuery(`SELECT count(*)::integer AS count FROM ${identifier(name)}`)
  const [targetCount] = await targetQuery(`SELECT count(*)::integer AS count FROM ${identifier(name)}`)
  if (targetCount.count < sourceCount.count) {
    throw new Error(`${name} verification failed: source=${sourceCount.count}, target=${targetCount.count}`)
  }
  return { table: name, sourceRows: sourceCount.count, targetRows: targetCount.count }
}

const sourcePool = postgresPool(sourceUrl, {
  ...process.env,
  DATABASE_APPLICATION_NAME: 'venn-fire-migration-source',
  DATABASE_POOL_MAX: '1',
})
const targetPool = postgresPool(targetUrl, {
  ...process.env,
  DATABASE_APPLICATION_NAME: 'venn-fire-migration-target',
  DATABASE_POOL_MAX: '1',
})
const sourceClient = await sourcePool.connect()
const targetClient = await targetPool.connect()
const sourceQuery = async (text, parameters = []) => (await sourceClient.query(text, parameters)).rows
const targetQuery = async (text, parameters = []) => (await targetClient.query(text, parameters)).rows

try {
  await targetClient.query('BEGIN')
  await ensureDatabaseSchema(targetQuery)
  await ensureFlightHistorySchema(targetQuery)

  await sourceClient.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const results = []
  for (const table of TABLES) {
    results.push(await copyTable({ sourceQuery, targetQuery, ...table }))
  }
  const publicDatasets = await rebuildPublicDatasets(targetQuery)

  await sourceClient.query('COMMIT')
  await targetClient.query('COMMIT')
  console.log(JSON.stringify({ ok: true, tables: results, publicDatasets }, null, 2))
} catch (error) {
  await Promise.allSettled([
    sourceClient.query('ROLLBACK'),
    targetClient.query('ROLLBACK'),
  ])
  throw error
} finally {
  sourceClient.release()
  targetClient.release()
  await closePostgresPools()
}
