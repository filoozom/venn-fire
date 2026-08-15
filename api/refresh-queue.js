import { databaseQuery } from '../server/database.mjs'
import { refreshAllSources } from '../server/refresh-sources.mjs'
import {
  claimRefreshSchedulerTick,
  completeRefreshSchedulerTick,
  failRefreshSchedulerTick,
  handleRefreshQueueCallback,
  isActiveRefreshScheduler,
  scheduleNextRefresh,
} from '../server/refresh-scheduler.mjs'

export default handleRefreshQueueCallback(async (message, metadata) => {
  const requestedAtMs = Date.now()
  const query = databaseQuery()
  const active = await isActiveRefreshScheduler(message?.deploymentId, query)

  if (!active) {
    console.log(JSON.stringify({
      event: 'stale-refresh-queue-message',
      requestedAt: new Date(requestedAtMs).toISOString(),
      scheduledFor: message?.scheduledFor ?? null,
      deploymentId: message?.deploymentId ?? null,
      messageId: metadata.messageId,
    }))
    return
  }

  const tick = await claimRefreshSchedulerTick({
    deploymentId: message.deploymentId,
    scheduledFor: message.scheduledFor,
    messageId: metadata.messageId,
  }, query)

  if (!tick.claimed) {
    console.log(JSON.stringify({
      event: 'duplicate-refresh-queue-message',
      requestedAt: new Date(requestedAtMs).toISOString(),
      scheduledFor: tick.scheduledFor,
      deploymentId: message.deploymentId,
      messageId: metadata.messageId,
      tickStatus: tick.status,
    }))
    if (tick.status === 'running') throw new Error('Refresh scheduler tick is already running')
    return
  }

  try {
    // Schedule first so a temporary provider failure cannot break the wake-up
    // chain. The failed message is retried independently by Vercel Queues.
    const scheduler = await scheduleNextRefresh({ nowMs: requestedAtMs })
    const sources = await refreshAllSources({ requestedAtMs })
    const failed = sources.filter((source) => source.status === 'failed')

    if (failed.length) {
      throw new Error(`Source refresh failed: ${failed.map((source) => source.sourceKey).join(', ')}`)
    }

    await completeRefreshSchedulerTick({
      deploymentId: message.deploymentId,
      scheduledFor: message.scheduledFor,
      metadata: { nextScheduledFor: scheduler.scheduledFor },
    }, query)

    console.log(JSON.stringify({
      event: 'queued-source-refresh',
      requestedAt: new Date(requestedAtMs).toISOString(),
      scheduledFor: message.scheduledFor,
      messageId: metadata.messageId,
      deliveryCount: metadata.deliveryCount,
      scheduler,
      sources,
    }))
  } catch (error) {
    await failRefreshSchedulerTick({
      deploymentId: message.deploymentId,
      scheduledFor: message.scheduledFor,
      error,
    }, query)
    throw error
  }
}, {
  visibilityTimeoutSeconds: 120,
  retry: (_error, metadata) => ({
    afterSeconds: Math.min(300, Math.max(30, metadata.deliveryCount * 30)),
  }),
})
