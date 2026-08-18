import { DuplicateMessageError, QueueClient } from '@vercel/queue'

import { REFRESH_INTERVAL_MS, REFRESH_OFFSET_MS, nextRefreshWakeAt } from './refresh-cadence.mjs'

import {
  databaseQuery,
  ensureDatabaseSchema,
  loadDataset,
  saveDataset,
} from './database.mjs'

export const REFRESH_QUEUE_TOPIC = 'venn-fire-refresh'
export const REFRESH_SCHEDULER_DATASET = 'refresh-scheduler'
// Re-exported so existing importers keep one path to the cadence.
export { REFRESH_INTERVAL_MS, REFRESH_OFFSET_MS, nextRefreshWakeAt }

// Push consumers are deployment-pinned by Vercel. Postgres records which
// deployment owns the active chain so an older deployment stops at its next
// wake-up after a release.
const queue = new QueueClient({ region: 'fra1' })

export const handleRefreshQueueCallback = queue.handleNodeCallback

export function refreshSchedulerDeployment(environment = process.env) {
  const deploymentId = environment.VERCEL_DEPLOYMENT_ID?.trim()
  if (!deploymentId) throw new Error('VERCEL_DEPLOYMENT_ID is required to schedule refreshes')
  return {
    deploymentId,
    gitCommitSha: environment.VERCEL_GIT_COMMIT_SHA?.trim() || null,
  }
}

export async function activateRefreshScheduler({
  environment = process.env,
  query = databaseQuery(),
} = {}) {
  const deployment = refreshSchedulerDeployment(environment)
  await saveDataset({
    key: REFRESH_SCHEDULER_DATASET,
    payload: { schemaVersion: 1, ...deployment },
    sourceUpdatedAt: null,
  }, query)
  return deployment
}

export async function isActiveRefreshScheduler(deploymentId, query = databaseQuery()) {
  if (!deploymentId) return false
  const current = await loadDataset(REFRESH_SCHEDULER_DATASET, query)
  return current?.payload?.deploymentId === deploymentId
}

function schedulerTickAt(value) {
  const timestampMs = Date.parse(value)
  if (!Number.isFinite(timestampMs)) throw new Error('A valid scheduled refresh time is required')
  return new Date(timestampMs).toISOString()
}

export async function claimRefreshSchedulerTick({
  deploymentId,
  scheduledFor,
  messageId = null,
}, query = databaseQuery()) {
  if (!deploymentId) throw new Error('A scheduler deployment ID is required')
  const tickAt = schedulerTickAt(scheduledFor)
  await ensureDatabaseSchema(query)
  const rows = await query(`
    INSERT INTO refresh_scheduler_ticks (
      deployment_id, scheduled_for, status, message_id, started_at
    ) VALUES ($1, $2::timestamptz, 'running', $3, now())
    ON CONFLICT (deployment_id, scheduled_for) DO UPDATE SET
      status = 'running',
      message_id = EXCLUDED.message_id,
      started_at = now(),
      completed_at = NULL,
      error = NULL,
      metadata = '{}'::jsonb
    WHERE refresh_scheduler_ticks.status = 'failed'
       OR (refresh_scheduler_ticks.status = 'running'
           AND refresh_scheduler_ticks.started_at < now() - interval '4 minutes')
    RETURNING status
  `, [deploymentId, tickAt, messageId])
  if (rows.length) return { claimed: true, status: 'running', scheduledFor: tickAt }

  const existing = await query(`
    SELECT status
    FROM refresh_scheduler_ticks
    WHERE deployment_id = $1 AND scheduled_for = $2::timestamptz
  `, [deploymentId, tickAt])
  return { claimed: false, status: existing[0]?.status ?? 'unknown', scheduledFor: tickAt }
}

export async function completeRefreshSchedulerTick({
  deploymentId,
  scheduledFor,
  metadata = {},
}, query = databaseQuery()) {
  await query(`
    UPDATE refresh_scheduler_ticks
    SET status = 'ok', completed_at = now(), error = NULL, metadata = $3::jsonb
    WHERE deployment_id = $1 AND scheduled_for = $2::timestamptz
  `, [deploymentId, schedulerTickAt(scheduledFor), JSON.stringify(metadata)])
}

export async function failRefreshSchedulerTick({
  deploymentId,
  scheduledFor,
  error,
}, query = databaseQuery()) {
  const message = String(error?.message ?? error ?? 'Unknown scheduler failure').slice(0, 2_000)
  await query(`
    UPDATE refresh_scheduler_ticks
    SET status = 'failed', completed_at = now(), error = $3
    WHERE deployment_id = $1 AND scheduled_for = $2::timestamptz
  `, [deploymentId, schedulerTickAt(scheduledFor), message])
}

export async function scheduleNextRefresh({ nowMs = Date.now() } = {}) {
  const deployment = refreshSchedulerDeployment()
  const scheduledForMs = nextRefreshWakeAt(nowMs)
  const scheduledFor = new Date(scheduledForMs).toISOString()
  const delaySeconds = Math.max(0, Math.ceil((scheduledForMs - nowMs) / 1_000))
  const idempotencyKey = `refresh-wake:${scheduledFor}`

  try {
    const { messageId } = await queue.send(
      REFRESH_QUEUE_TOPIC,
      { schemaVersion: 1, scheduledFor, ...deployment },
      {
        delaySeconds,
        idempotencyKey,
        retentionSeconds: 3_600,
      },
    )
    return { ok: true, scheduledFor, delaySeconds, messageId, duplicate: false, ...deployment }
  } catch (error) {
    if (error instanceof DuplicateMessageError) {
      return { ok: true, scheduledFor, delaySeconds, messageId: null, duplicate: true, ...deployment }
    }
    throw error
  }
}
