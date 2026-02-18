import express from 'express'
import { requireAuth } from './auth.js'
import { connectMongo, isMongoEnabled } from './db.js'
import { Event } from './models/Event.js'

function parseDate(value) {
  if (!value) return null
  const d = new Date(String(value))
  return Number.isFinite(d.getTime()) ? d : null
}

function parseLimit(value, fallback = 50) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  if (i <= 0) return fallback
  return Math.min(i, 200)
}

function isAdmin(req) {
  const token = process.env.ADMIN_TOKEN
  if (!token) return false
  const header = req.headers['x-admin-token']
  return typeof header === 'string' && header === token
}

export function createEventsReadApi() {
  const router = express.Router()

  router.get('/api/events', requireAuth, async (req, res, next) => {
    try {
      if (!isMongoEnabled()) return res.status(503).json({ error: 'mongo_not_configured' })
      const conn = await connectMongo()
      if (!conn.enabled) return res.status(503).json({ error: 'mongo_unavailable' })

      const type = typeof req.query?.type === 'string' ? req.query.type.trim() : ''
      const actorQuery = typeof req.query?.actor === 'string' ? req.query.actor.trim() : ''
      const from = parseDate(req.query?.from)
      const to = parseDate(req.query?.to)
      const limit = parseLimit(req.query?.limit, 50)

      const filter = {}
      if (type) filter.type = type

      if (isAdmin(req)) {
        if (actorQuery) filter.actor = actorQuery
      } else {
        // non-admin: только свои события (и игнорируем actor из query)
        filter.actor = req.user.id
      }

      if (from || to) {
        filter.ts = {}
        if (from) filter.ts.$gte = from
        if (to) filter.ts.$lte = to
      }

      const docs = await Event.find(filter)
        .sort({ ts: -1, createdAt: -1 })
        .limit(limit)
        .lean()

      const events = docs.map((e) => ({
        id: String(e._id),
        type: e.type,
        actor: e.actor ?? e.userId ?? null,
        target: e.target ?? e.entityId ?? null,
        ts: (e.ts ?? e.createdAt)?.toISOString?.() ?? null,
        meta: e.meta ?? null,
      }))

      res.json(events)
    } catch (e) {
      next(e)
    }
  })

  return router
}

