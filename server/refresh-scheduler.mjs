import { DuplicateMessageError, QueueClient } from '@vercel/queue'

import { databaseQuery, loadDataset, saveDataset } from './database.mjs'

export const REFRESH_QUEUE_TOPIC = 'venn-fire-refresh'
export const REFRESH_INTERVAL_MS = 5 * 60_000
export const REFRESH_OFFSET_MS = 2 * 60_000
export const REFRESH_SCHEDULER_DATASET = 'refresh-scheduler'

// Push consumers are deployment-pinned by Vercel. Postgres records which
// deployment owns the active chain so an older deployment stops at its next
// wake-up after a release.
const queue = new QueueClient({ region: 'fra1' })

export const handleRefreshQueueCallback = queue.handleNodeCallback

export function nextRefreshWakeAt(nowMs = Date.now()) {
  const slot = Math.floor((nowMs - REFRESH_OFFSET_MS) / REFRESH_INTERVAL_MS) + 1
  return slot * REFRESH_INTERVAL_MS + REFRESH_OFFSET_MS
}

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
