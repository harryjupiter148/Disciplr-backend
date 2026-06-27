import { NotificationService } from '../services/notifications/factory.js'
import { processJob as processExportJob } from '../services/exportQueue.js'
import type { JobHandler, JobType } from './types.js'
import { markVaultExpiries, sendMilestoneReminders } from '../services/vaultExpiry.service.js'
import { cleanupExpiredSessions } from '../services/session.js'
import { buildSlashOnMissPayload } from '../services/soroban.js'
import { relayOutboxBatch } from '../services/outboxRelay.js'
import {
  runReindexBatches,
  type MilestoneEmbeddingSource,
  type ReindexCursorStore,
} from '../services/evidenceReindex.js'
import type { EmbeddingProvider } from '../services/embeddingProvider.js'

type JobHandlerRegistry = {
  [K in JobType]: JobHandler<K>
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const logJob = (type: JobType, message: string): void => {
  console.log(`[jobs:${type}] ${message}`)
}

export interface EmbeddingReindexDependencies {
  source: MilestoneEmbeddingSource
  cursorStore: ReindexCursorStore
  embeddingProvider: EmbeddingProvider
}

export const createDefaultJobHandlers = (
  notificationService: NotificationService,
  embeddingReindex: EmbeddingReindexDependencies,
): JobHandlerRegistry => ({
  'notification.send': async (payload, context) => {
    await notificationService.send(payload.recipient, payload.subject, payload.body)
    logJob('notification.send', `executed job_id=${context.jobId} attempt=${context.attempt}`)
  },
  'deadline.check': async (payload, context) => {
    await sleep(30)
    const expiredCount = await markVaultExpiries()
    const target = payload.vaultId ?? 'all-active-vaults'
    const deadline = payload.deadlineIso ?? 'not-provided'
    logJob(
      'deadline.check',
      `checked target=${target} deadline=${deadline} expired=${expiredCount} source=${payload.triggerSource} attempt=${context.attempt}`,
    )
    if (payload.vaultId) {
      const sorobanPayload = buildSlashOnMissPayload(payload.vaultId)
      logJob(
        'deadline.check',
        `slash_on_miss built vault=${payload.vaultId} status=${sorobanPayload.submission.status}`,
      )
    }
  },
  'milestone.reminders': async (payload, context) => {
    const remindersSent = await sendMilestoneReminders({
      leadTimesMs: payload.leadTimesMs,
      limit: payload.limit,
    })
    logJob(
      'milestone.reminders',
      `sent ${remindersSent} reminders attempt=${context.attempt}`,
    )
  },
  'oracle.call': async (payload, context) => {
    await sleep(60)
    const requestId = payload.requestId ?? context.jobId
    logJob(
      'oracle.call',
      `oracle=${payload.oracle} symbol=${payload.symbol} requestId=${requestId} attempt=${context.attempt}`,
    )
  },
  'analytics.recompute': async (payload, context) => {
    await sleep(120)
    const entity = payload.entityId ?? 'all'
    const reason = payload.reason ?? 'unspecified'
    logJob(
      'analytics.recompute',
      `scope=${payload.scope} entity=${entity} reason=${reason} attempt=${context.attempt}`,
    )
  },
  'export.generate': async (payload, context) => {
    await processExportJob(payload.exportJobId, undefined, context.attempt)
    logJob(
      'export.generate',
      `exportJobId=${payload.exportJobId} attempt=${context.attempt}`,
    )
  },
  'sessions.cleanup': async (payload, context) => {
    const batchSize = payload.batchSize ?? 1000
    const deleted = await cleanupExpiredSessions(batchSize)
    logJob(
      'sessions.cleanup',
      `deleted=${deleted} batchSize=${batchSize} attempt=${context.attempt}`,
    )
  },
  'outbox.relay': async (payload, context) => {
    const count = await relayOutboxBatch()
    logJob(
      'outbox.relay',
      `relayed=${count} attempt=${context.attempt}`,
    )
  },
  'embeddings.reindex': async (payload, context) => {
    const result = await runReindexBatches({
      source: embeddingReindex.source,
      cursorStore: embeddingReindex.cursorStore,
      embeddingProvider: embeddingReindex.embeddingProvider,
      batchSize: payload.batchSize,
      maxBatchesPerRun: payload.maxBatchesPerRun,
    })
    logJob(
      'embeddings.reindex',
      `batches=${result.batches} processed=${result.processed} reindexed=${result.reindexed} ` +
        `skipped=${result.skippedUpToDate} cursor=${result.cursor ?? 'none'} done=${result.done} attempt=${context.attempt}`,
    )
  },
})
