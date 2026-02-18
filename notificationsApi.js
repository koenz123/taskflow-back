import express from 'express'
import mongoose from 'mongoose'
import { requireAuth } from './auth.js'
import { sendTelegramNotification } from './telegramBot.js'
import { tryResolveAuthUser } from './authSession.js'

function toNotificationDto(doc) {
  if (!doc) return null
  return {
    id: String(doc._id),
    userId: doc.userId ?? null,
    text: doc.text ?? '',
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    meta: doc.meta ?? null,
  }
}

export function createNotificationsApi({ dataDir }) {
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  // Soft auth list: return [] if not logged in (prevents retry storms).
  router.get('/api/notifications', async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.json([])
    const userId = r.userId

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const col = db.collection('notifications')
    const items = await col
      .find({ userId: String(userId) })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray()

    res.json(items.map(toNotificationDto))
  })

  // A single endpoint frontend can call when it shows a notification in UI.
  // Stores history + (optionally) sends to Telegram by telegramUserId.
  router.post('/api/notifications', requireAuth, async (req, res) => {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'unauthorized' })

    const text = String(req.body?.text || '').trim()
    if (!text) return res.status(400).json({ error: 'bad_payload' })

    const meta = req.body?.meta && typeof req.body.meta === 'object' ? req.body.meta : null

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const col = db.collection('notifications')
    const now = new Date()
    const insertRes = await col.insertOne({
      userId: String(userId),
      text,
      meta,
      createdAt: now,
    })

    // If frontend supplies telegramUserId (or if we can infer later), send message.
    const telegramUserId = typeof req.body?.telegramUserId === 'string' ? req.body.telegramUserId.trim() : ''
    let telegram = null
    if (telegramUserId) {
      try {
        telegram = await sendTelegramNotification({ dataDir, text, telegramUserId })
      } catch (e) {
        telegram = { ok: false, error: 'send_failed' }
      }
    }

    const doc = await col.findOne({ _id: insertRes.insertedId })
    res.status(201).json({ ok: true, notification: toNotificationDto(doc), telegram })
  })

  return router
}

