#!/usr/bin/env node

import {
  databaseQuery,
  databaseUrl,
  ensureDatabaseSchema,
  rebuildPublicDatasets,
} from '../server/database.mjs'
import { ensureFlightHistorySchema } from '../server/flight-history.mjs'
import { closePostgresPools } from '../server/postgres.mjs'

const url = databaseUrl()
if (!url) {
  throw new Error('Set PGHOST/PGPASSWORD/PG_CA_PEM, DATABASE_URL or POSTGRES_URL before bootstrapping PostgreSQL')
}

try {
  const query = databaseQuery(url)
  await ensureDatabaseSchema(query)
  await ensureFlightHistorySchema(query)
  const publicDatasets = await rebuildPublicDatasets(query)
  const [database] = await query(`
    SELECT current_database() AS database_name,
           current_user AS database_user,
           current_setting('server_version') AS server_version
  `)
  console.log(JSON.stringify({ ok: true, ...database, publicDatasets }, null, 2))
} finally {
  await closePostgresPools()
}
