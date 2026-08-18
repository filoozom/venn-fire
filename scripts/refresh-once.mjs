#!/usr/bin/env node
// One-shot source refresh for self-hosted deployments: useful for seeding a new
// database and for hosts that would rather drive the cadence from their own cron
// than leave the server's internal scheduler enabled.
import { closePostgresPools } from '../server/postgres.mjs'
import { refreshAllSources } from '../server/refresh-sources.mjs'

const requestedAtMs = Date.now()
try {
  const sources = await refreshAllSources({ requestedAtMs })
  const failed = sources.filter((source) => source.status === 'failed')
  console.log(JSON.stringify({
    ok: failed.length === 0,
    generatedAt: new Date(requestedAtMs).toISOString(),
    durationMs: Date.now() - requestedAtMs,
    sources: sources.length,
    failed,
  }, null, 2))
  if (failed.length) process.exitCode = 1
} finally {
  await closePostgresPools()
}
