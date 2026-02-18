import express from 'express'
import { requireAuth } from './auth.js'
import { logBusinessEvent } from './logBusinessEvent.js'

function normalizeSource(value) {
  if (value == null) return null
  const s = String(value).trim()
  if (!s) return null
  if (s.length > 50) return null
  return s
}

function parseDelta(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  // keep smallish deltas sane
  if (Math.abs(n) > 1_000_000) return null
  return n
}

export function createBalanceApi({ balanceRepo }) {
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  router.get('/api/balance', requireAuth, async (req, res, next) => {
    try {
      const balance = await balanceRepo.get(req.user.id)
      res.json({ userId: req.user.id, balance })
    } catch (e) {
      next(e)
    }
  })

  // Internal economy tool (and usable by UI until real auth exists).
  router.post('/api/balance/adjust', requireAuth, async (req, res, next) => {
    try {
      const targetUserId =
        typeof req.body?.userId === 'string' && req.body.userId.trim() ? req.body.userId.trim() : req.user.id
      const delta = parseDelta(req.body?.delta)
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''

      if (!targetUserId) return res.status(400).json({ error: 'missing_userId' })
      if (delta == null) return res.status(400).json({ error: 'invalid_delta' })
      if (!reason) return res.status(400).json({ error: 'missing_reason' })

      const sourceHeader = req.headers['x-event-source'] ?? req.headers['x-balance-source'] ?? null
      const source = normalizeSource(req.body?.source ?? sourceHeader) ?? 'manual'

      const newBalance = await balanceRepo.adjust(targetUserId, delta)

      await logBusinessEvent({
        req,
        event: 'BALANCE_CHANGED',
        actor: targetUserId, // actor == баланс владельца (пока нет админ-ролей)
        target: null,
        meta: {
          delta,
          reason,
          newBalance,
          source,
        },
      })

      res.json({ userId: targetUserId, balance: newBalance })
    } catch (e) {
      next(e)
    }
  })

  return router
}

