import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/rbac.js'
import { UserRole } from '../types/user.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { db } from '../db/knex.js'
import { replayDeadLetter } from '../services/webhooks.js'

export const adminWebhooksRouter = Router()

adminWebhooksRouter.use(authenticate)
adminWebhooksRouter.use(requireAdmin)

adminWebhooksRouter.get('/dead-letters', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50
    const offset = req.query.offset ? Number(req.query.offset) : 0

    const query = db('webhook_dead_letters').orderBy('failed_at', 'desc')

    if (req.query.subscriber_id) {
      query.where('subscriber_id', req.query.subscriber_id)
    }

    const [{ total }] = await query.clone().count('* as total')
    const entries = await query.limit(limit).offset(offset)

    res.status(200).json({
      webhook_dead_letters: entries,
      count: entries.length,
      total: Number(total),
      limit,
      offset,
      has_more: offset + entries.length < Number(total),
    })
  } catch (error) {
    console.error('Error fetching webhook dead letters:', error)
    res.status(500).json({ error: 'Failed to fetch dead letters' })
  }
})

adminWebhooksRouter.post('/dead-letters/:id/replay', async (req: Request, res: Response) => {
  try {
    const result = await replayDeadLetter(req.params.id)

    if (!result.replayed) {
      res.status(404).json({ error: result.error })
      return
    }

    createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'webhook.deadletter.replay',
      target_type: 'webhook_dead_letter',
      target_id: req.params.id,
      metadata: {
        subscriberId: result.subscriberId,
      },
    })

    res.status(202).json({ replayed: true })
  } catch (error) {
    console.error('Error replaying webhook dead letter:', error)
    res.status(500).json({ error: 'Failed to replay dead letter' })
  }
})
