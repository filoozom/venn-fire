import { refreshAllSources } from '../server/refresh-sources.mjs'
import {
  handleRefreshQueueCallback,
  isActiveRefreshScheduler,
  scheduleNextRefresh,
} from '../server/refresh-scheduler.mjs'

export default handleRefreshQueueCallback(async (message, metadata) => {
  const requestedAtMs = Date.now()
  const active = await isActiveRefreshScheduler(message?.deploymentId)

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

  // Schedule first so a temporary provider failure cannot break the wake-up
  // chain. The failed message is retried independently by Vercel Queues.
  const scheduler = await scheduleNextRefresh({ nowMs: requestedAtMs })
  const sources = await refreshAllSources({ requestedAtMs })
  const failed = sources.filter((source) => source.status === 'failed')

  console.log(JSON.stringify({
    event: 'queued-source-refresh',
    requestedAt: new Date(requestedAtMs).toISOString(),
    scheduledFor: message?.scheduledFor ?? null,
    messageId: metadata.messageId,
    deliveryCount: metadata.deliveryCount,
    scheduler,
    sources,
  }))

  if (failed.length) {
    throw new Error(`Source refresh failed: ${failed.map((source) => source.sourceKey).join(', ')}`)
  }
}, {
  visibilityTimeoutSeconds: 120,
  retry: (_error, metadata) => ({
    afterSeconds: Math.min(300, Math.max(30, metadata.deliveryCount * 30)),
  }),
})
