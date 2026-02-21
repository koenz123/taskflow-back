import express from 'express'
import mongoose from 'mongoose'
import { requireAuth } from './auth.js'
import { sendTelegramNotification } from './telegramBot.js'
import { tryResolveAuthUser } from './authSession.js'

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function toStr(v) {
  return typeof v === 'string' ? v : ''
}

function normalizeNotificationMeta(meta) {
  if (!isObject(meta)) return null
  return meta
}

function mapNotificationType({ text, meta }) {
  const t = toStr(meta?.type).trim()
  // Preferred: explicit frontend/backend "canonical" type.
  if (t) return t

  // Legacy server-side types (written by applicationsApi).
  // Keep mapping narrow; unknown types degrade to task_taken.
  if (toStr(meta?.violationType)) {
    const sanction = isObject(meta?.sanction) ? meta.sanction : null
    const kind = toStr(sanction?.kind)
    if (kind === 'ban') return 'executor_violation_ban'
    if (kind === 'respond_block') return 'executor_violation_respond_block'
    if (kind === 'rating_penalty') return 'executor_violation_rating_penalty'
    return 'executor_violation_warning'
  }

  // Heuristic fallback: if the server stored a generic message and has a taskId,
  // it is usually the "task taken" flow.
  if (toStr(meta?.taskId)) return 'task_taken'

  // Absolute last resort.
  if (typeof text === 'string' && text.trim()) return 'task_taken'
  return 'task_taken'
}

function mapActorUserId(meta) {
  const actorUserId = toStr(meta?.actorUserId).trim()
  if (actorUserId) return actorUserId
  // Backward-compatibility: some older server-side notifications carried executorId.
  const executorId = toStr(meta?.executorId).trim()
  if (executorId) return executorId
  return 'system'
}

function mapTaskId(meta) {
  const taskId = toStr(meta?.taskId).trim()
  return taskId || ''
}

function toNotificationDto(doc) {
  if (!doc) return null
  const meta = normalizeNotificationMeta(doc.meta)
  const createdAtIso = doc.createdAt ? new Date(doc.createdAt).toISOString() : null
  const readAtIso = doc.readAt ? new Date(doc.readAt).toISOString() : null
  const text = doc.text ?? ''
  const type = mapNotificationType({ text, meta })
  const taskId = mapTaskId(meta)
  const actorUserId = mapActorUserId(meta)
  return {
    id: String(doc._id),
    // Legacy/raw payload (kept for backward compatibility).
    userId: doc.userId ?? null,
    text,
    meta,
    createdAt: createdAtIso,
    readAt: readAtIso,

    // Canonical payload for modern frontend (Notification model).
    type,
    recipientUserId: doc.userId ?? null,
    actorUserId,
    taskId,

    // Optional canonical fields (best-effort from meta).
    disputeId: toStr(meta?.disputeId).trim() || undefined,
    disputeStatus: toStr(meta?.disputeStatus).trim() || undefined,
    slaHoursLeft: typeof meta?.slaHoursLeft === 'number' ? meta.slaHoursLeft : undefined,
    completionVideoUrl: toStr(meta?.completionVideoUrl).trim() || undefined,
    message: toStr(meta?.message).trim() || undefined,
    violationId: toStr(meta?.violationId).trim() || undefined,
    violationType: toStr(meta?.violationType).trim() || undefined,
    sanctionDeltaPercent:
      typeof meta?.sanctionDeltaPercent === 'number' ? meta.sanctionDeltaPercent : undefined,
    sanctionUntil: toStr(meta?.sanctionUntil).trim() || undefined,
    sanctionDurationHours:
      typeof meta?.sanctionDurationHours === 'number' ? meta.sanctionDurationHours : undefined,
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

  // Mark one notification as read.
  router.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'unauthorized' })

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.id))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_notification_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const now = new Date()
    const col = db.collection('notifications')
    const updated = await col.findOneAndUpdate(
      { _id: oid, userId: String(userId) },
      { $set: { readAt: now } },
      { returnDocument: 'after' },
    )
    const doc = updated?.value ?? updated
    if (!doc) return res.status(404).json({ error: 'not_found' })
    return res.json({ ok: true, notification: toNotificationDto(doc) })
  })

  // Mark all notifications as read.
  router.post('/api/notifications/read-all', requireAuth, async (req, res) => {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'unauthorized' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const now = new Date()
    const col = db.collection('notifications')
    await col.updateMany(
      { userId: String(userId), readAt: { $exists: false } },
      { $set: { readAt: now } },
    )
    await col.updateMany(
      { userId: String(userId), readAt: null },
      { $set: { readAt: now } },
    )
    return res.json({ ok: true })
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

