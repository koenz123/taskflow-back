import express from 'express'
import mongoose from 'mongoose'
import { tryResolveAuthUser } from '../auth/authSession.js'
import { createNotification } from '../services/notificationService.js'

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function getAuthIds(r) {
  const userMongoId = String(r.userId)
  const telegramUserId =
    typeof r.user?.telegramUserId === 'string' && r.user.telegramUserId ? r.user.telegramUserId : null
  const userPublicId = telegramUserId ? `tg_${telegramUserId}` : userMongoId
  return { userMongoId, userPublicId }
}

async function addNotification(db, userMongoId, text, meta = null) {
  try {
    if (!userMongoId) return
    const msg = String(text || '').trim()
    if (!msg) return
    await createNotification({ db, userId: String(userMongoId), text: msg, meta })
  } catch {
    // ignore (best-effort)
  }
}

async function resolveMongoIdFromPublicId(db, publicId) {
  const raw = String(publicId || '').trim()
  if (!raw) return null
  const m = raw.match(/^tg_(\d+)$/)
  if (m) {
    const u = await db.collection('users').findOne({ telegramUserId: m[1] }, { projection: { _id: 1 } })
    return u?._id ? String(u._id) : null
  }
  try {
    const oid = new mongoose.Types.ObjectId(raw)
    return String(oid)
  } catch {
    return null
  }
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return undefined
  const out = value
    .map((x) => {
      if (!isObject(x)) return null
      const kind = x.kind
      if (kind === 'link') {
        const url = typeof x.url === 'string' ? x.url.trim() : ''
        if (!url) return null
        const title = typeof x.title === 'string' && x.title.trim() ? x.title.trim() : undefined
        return { kind: 'link', url, title }
      }
      if (kind === 'timestamp') {
        const seconds = typeof x.seconds === 'number' && Number.isFinite(x.seconds) ? x.seconds : NaN
        if (!Number.isFinite(seconds) || seconds < 0) return null
        const note = typeof x.note === 'string' && x.note.trim() ? x.note.trim() : undefined
        return { kind: 'timestamp', seconds, note }
      }
      if (kind === 'fileRef') {
        const name = typeof x.name === 'string' ? x.name.trim() : ''
        if (!name) return null
        const url = typeof x.url === 'string' && x.url.trim() ? x.url.trim() : undefined
        return { kind: 'fileRef', name, url }
      }
      return null
    })
    .filter(Boolean)
  return out.length ? out : undefined
}

function toDto(doc) {
  if (!doc) return null
  const { _id, createdAt, ...rest } = doc
  return {
    id: String(_id),
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    ...rest,
  }
}

async function canAccessDispute({ db, disputeId, userPublicId, userMongoId, role }) {
  let oid = null
  try {
    oid = new mongoose.Types.ObjectId(String(disputeId))
  } catch {
    oid = null
  }
  if (!oid) return { ok: false, error: 'bad_dispute_id' }
  const disputes = db.collection('disputes')
  const dispute = await disputes.findOne({ _id: oid }, { readPreference: 'primary' })
  if (!dispute) return { ok: false, error: 'not_found' }

  const isArbiter = role === 'arbiter'
  const isExecutor = role === 'executor' && (dispute.executorId === userPublicId || dispute.executorId === userMongoId)
  const isCustomer = role === 'customer' && (dispute.customerId === userPublicId || dispute.customerId === userMongoId)
  if (!isArbiter && !isExecutor && !isCustomer) return { ok: false, error: 'forbidden' }
  return { ok: true, dispute, isArbiter, isExecutor, isCustomer }
}

export function createDisputeMessagesApi() {
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  // Backward-compatible REST shape: /api/disputes/:id/messages
  router.get('/api/disputes/:disputeId/messages', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.json([])
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    const { userMongoId, userPublicId } = getAuthIds(r)

    const disputeId = typeof req.params?.disputeId === 'string' ? req.params.disputeId.trim() : ''
    if (!disputeId) return res.json([])

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const access = await canAccessDispute({ db, disputeId, userPublicId, userMongoId, role })
    if (!access.ok) return res.status(access.error === 'forbidden' ? 403 : 400).json({ error: access.error })

    const msgs = db.collection('disputeMessages')
    const items = await msgs.find({ disputeId }).sort({ createdAt: 1 }).limit(1000).toArray()
    return res.json(items.map(toDto))
  }))

  // Backward-compatible REST shape: /api/disputes/:id/messages
  router.post('/api/disputes/:disputeId/messages', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    const { userMongoId, userPublicId } = getAuthIds(r)

    const disputeId = typeof req.params?.disputeId === 'string' ? req.params.disputeId.trim() : ''
    const text = typeof req.body?.text === 'string' ? req.body.text : ''
    if (!disputeId) return res.status(400).json({ error: 'missing_disputeId' })
    if (!text.trim()) return res.status(400).json({ error: 'missing_text' })

    const kindRaw = typeof req.body?.kind === 'string' ? req.body.kind : 'public'
    const kind = kindRaw === 'public' || kindRaw === 'system' || kindRaw === 'internal' ? kindRaw : 'public'

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const access = await canAccessDispute({ db, disputeId, userPublicId, userMongoId, role })
    if (!access.ok) return res.status(access.error === 'forbidden' ? 403 : 400).json({ error: access.error })

    // Only arbiters can post system/internal messages.
    if ((kind === 'system' || kind === 'internal') && !access.isArbiter) {
      return res.status(403).json({ error: 'forbidden' })
    }

    const attachments = normalizeAttachments(req.body?.attachments)
    const now = new Date()
    const msgs = db.collection('disputeMessages')
    const insertRes = await msgs.insertOne({
      disputeId,
      authorUserId: userPublicId,
      kind,
      text,
      attachments,
      createdAt: now,
    })
    const doc = await msgs.findOne({ _id: insertRes.insertedId }, { readPreference: 'primary' })

    // Best-effort: notify other party (and assigned arbiter) about a new message.
    try {
      const contracts = db.collection('contracts')
      const contractId = typeof access.dispute?.contractId === 'string' ? access.dispute.contractId : null
      let taskId = null
      if (contractId) {
        let cOid = null
        try {
          cOid = new mongoose.Types.ObjectId(contractId)
        } catch {
          cOid = null
        }
        if (cOid) {
          const c = await contracts.findOne({ _id: cOid }, { readPreference: 'primary' })
          taskId = typeof c?.taskId === 'string' ? c.taskId : null
        }
      }

      const recipientPublicIds = []
      if (access.dispute?.customerId) recipientPublicIds.push(access.dispute.customerId)
      if (access.dispute?.executorId) recipientPublicIds.push(access.dispute.executorId)
      if (access.dispute?.assignedArbiterId) recipientPublicIds.push(access.dispute.assignedArbiterId)
      const unique = Array.from(new Set(recipientPublicIds)).filter((id) => id && id !== userPublicId)

      for (const pid of unique) {
        const mongoId = await resolveMongoIdFromPublicId(db, pid)
        if (!mongoId) continue
        await addNotification(db, mongoId, 'Новое сообщение в споре.', {
          type: 'dispute_message',
          disputeId,
          taskId: taskId ?? undefined,
          actorUserId: userPublicId,
          messageId: String(insertRes.insertedId),
        })
      }
    } catch {
      // ignore
    }

    return res.status(201).json(toDto(doc))
  }))

  router.get('/api/dispute-messages', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.json([])
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    const { userMongoId, userPublicId } = getAuthIds(r)

    const disputeId = typeof req.query?.disputeId === 'string' ? req.query.disputeId.trim() : ''
    if (!disputeId) return res.json([])

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const access = await canAccessDispute({ db, disputeId, userPublicId, userMongoId, role })
    if (!access.ok) return res.status(access.error === 'forbidden' ? 403 : 400).json({ error: access.error })

    const msgs = db.collection('disputeMessages')
    const items = await msgs.find({ disputeId }).sort({ createdAt: 1 }).limit(1000).toArray()
    return res.json(items.map(toDto))
  }))

  router.post('/api/dispute-messages', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    const { userMongoId, userPublicId } = getAuthIds(r)

    const disputeId = typeof req.body?.disputeId === 'string' ? req.body.disputeId.trim() : ''
    const text = typeof req.body?.text === 'string' ? req.body.text : ''
    if (!disputeId) return res.status(400).json({ error: 'missing_disputeId' })
    if (!text.trim()) return res.status(400).json({ error: 'missing_text' })

    const kindRaw = typeof req.body?.kind === 'string' ? req.body.kind : 'public'
    const kind = kindRaw === 'public' || kindRaw === 'system' || kindRaw === 'internal' ? kindRaw : 'public'

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const access = await canAccessDispute({ db, disputeId, userPublicId, userMongoId, role })
    if (!access.ok) return res.status(access.error === 'forbidden' ? 403 : 400).json({ error: access.error })

    // Only arbiters can post system/internal messages.
    if ((kind === 'system' || kind === 'internal') && !access.isArbiter) {
      return res.status(403).json({ error: 'forbidden' })
    }

    const attachments = normalizeAttachments(req.body?.attachments)
    const now = new Date()
    const msgs = db.collection('disputeMessages')
    const insertRes = await msgs.insertOne({
      disputeId,
      authorUserId: userPublicId,
      kind,
      text,
      attachments,
      createdAt: now,
    })
    const doc = await msgs.findOne({ _id: insertRes.insertedId }, { readPreference: 'primary' })
    return res.status(201).json(toDto(doc))
  }))

  return router
}

