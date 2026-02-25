import express from 'express'
import mongoose from 'mongoose'
import { tryResolveAuthUser } from '../auth/authSession.js'
import { requireAuth } from '../auth/auth.js'
import { connectMongo } from '../infra/db.js'
import { createNotification } from '../services/notificationService.js'

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}

function getAuthIds(r) {
  const userMongoId = String(r.userId)
  const telegramUserId =
    typeof r.user?.telegramUserId === 'string' && r.user.telegramUserId ? r.user.telegramUserId : null
  const userPublicId = telegramUserId ? `tg_${telegramUserId}` : userMongoId
  const role = typeof r.user?.role === 'string' ? r.user.role : 'pending'
  return { userMongoId, userPublicId, role }
}

function parseUserId(userId) {
  const raw = String(userId || '').trim()
  if (!raw) return null
  const m = raw.match(/^tg_(\d+)$/)
  if (m) return { kind: 'tg', telegramUserId: m[1] }
  try {
    return { kind: 'mongo', _id: new mongoose.Types.ObjectId(raw) }
  } catch {
    return null
  }
}

function fullNameFromUserDoc(userDoc) {
  if (!userDoc) return ''
  return (
    (typeof userDoc.fullName === 'string' && userDoc.fullName.trim()) ||
    [userDoc.firstName, userDoc.lastName].filter(Boolean).join(' ').trim() ||
    (typeof userDoc.username === 'string' && userDoc.username.trim()) ||
    String(userDoc._id)
  )
}

function toThreadDto(doc, userFullName) {
  if (!doc) return null
  const dto = {
    id: String(doc._id),
    userId: doc.userId ?? '',
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    status: typeof doc.status === 'string' ? doc.status : 'open',
    closedAt: doc.closedAt ? new Date(doc.closedAt).toISOString() : null,
    closedByUserId: doc.closedByUserId ?? null,
    rating: doc.rating != null ? Number(doc.rating) : null,
    ratingComment: typeof doc.ratingComment === 'string' ? doc.ratingComment : null,
    ratedAt: doc.ratedAt ? new Date(doc.ratedAt).toISOString() : null,
  }
  if (typeof userFullName === 'string') dto.userFullName = userFullName
  return dto
}

function toMessageDto(doc) {
  if (!doc) return null
  const attachmentUrls = Array.isArray(doc.attachmentUrls)
    ? doc.attachmentUrls.filter((u) => typeof u === 'string')
    : []
  return {
    id: String(doc._id),
    threadId: doc.threadId ? String(doc.threadId) : '',
    fromUserId: doc.fromUserId ?? '',
    text: doc.text ?? '',
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    attachmentUrls,
  }
}

export function createSupportApi() {
  const router = express.Router()
  router.use(express.json({ limit: '512kb' }))

  // GET /api/support/threads — list threads (arbiter: all; user: own only)
  router.get(
    '/api/support/threads',
    requireAuth,
    asyncHandler(async (req, res) => {
      const r = await tryResolveAuthUser(req)
      const { userPublicId, userMongoId, role } = getAuthIds(r)

      const conn = await connectMongo()
      if (!conn?.enabled || mongoose.connection.readyState !== 1) {
        return res.status(500).json({ error: 'mongo_not_available' })
      }
      const db = mongoose.connection.db
      if (!db) return res.status(500).json({ error: 'mongo_not_available' })

      const threads = db.collection('supportThreads')
      const query =
        role === 'arbiter' ? {} : { userId: { $in: [userPublicId, userMongoId].filter(Boolean) } }
      const list = await threads
        .find(query)
        .sort({ updatedAt: -1 })
        .limit(500)
        .toArray()

      const userIds = [...new Set(list.map((t) => t.userId).filter(Boolean))]
      const parsed = userIds.map(parseUserId).filter(Boolean)
      const mongoIds = parsed.filter((x) => x.kind === 'mongo').map((x) => x._id)
      const tgIds = parsed.filter((x) => x.kind === 'tg').map((x) => x.telegramUserId)
      const fullNameByUserId = new Map()
      if (parsed.length > 0) {
        const users = db.collection('users')
        const userQuery = { $or: [{ _id: { $in: mongoIds } }, { telegramUserId: { $in: tgIds } }] }
        const userDocs = await users
          .find(userQuery, {
            projection: { fullName: 1, firstName: 1, lastName: 1, username: 1, _id: 1, telegramUserId: 1 },
            readPreference: 'primary',
          })
          .toArray()
        for (const u of userDocs) {
          const publicId =
            typeof u.telegramUserId === 'string' && u.telegramUserId
              ? `tg_${u.telegramUserId}`
              : String(u._id)
          fullNameByUserId.set(publicId, fullNameFromUserDoc(u))
        }
      }

      return res.json(list.map((t) => toThreadDto(t, fullNameByUserId.get(t.userId))))
    }),
  )

  // POST /api/support/threads — body { userId, telegramUserId? }, create or return thread.
  // Allow for any role when creating for self (mongo id or tg_xxx); also allow arbiter for any userId.
  // Telegram-logged-in users: treat as self if body.userId is their public id or mongo id; optional body.telegramUserId match.
  router.post(
    '/api/support/threads',
    requireAuth,
    asyncHandler(async (req, res) => {
      const r = await tryResolveAuthUser(req)
      const { userPublicId, userMongoId, role } = getAuthIds(r)
      const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''
      const bodyTelegramUserId = typeof req.body?.telegramUserId === 'string' ? req.body.telegramUserId.trim() : null
      if (!userId) return res.status(400).json({ error: 'missing_userId' })

      const isSelf =
        userId === userMongoId ||
        userId === userPublicId ||
        (bodyTelegramUserId &&
          String(r.user?.telegramUserId ?? '') === bodyTelegramUserId &&
          (userId === userMongoId || userId === userPublicId))
      if (!isSelf && role !== 'arbiter') {
        return res.status(403).json({ error: 'forbidden' })
      }

      const conn = await connectMongo()
      if (!conn?.enabled || mongoose.connection.readyState !== 1) {
        return res.status(500).json({ error: 'mongo_not_available' })
      }
      const db = mongoose.connection.db
      if (!db) return res.status(500).json({ error: 'mongo_not_available' })

      const threads = db.collection('supportThreads')
      const existing = await threads.findOne({ userId }, { readPreference: 'primary' })
      if (existing && String(existing.status ?? 'open') !== 'closed') {
        return res.json(toThreadDto(existing))
      }

      const now = new Date()
      const insertRes = await threads.insertOne({
        userId,
        createdAt: now,
        updatedAt: now,
      })
      const thread = await threads.findOne({ _id: insertRes.insertedId }, { readPreference: 'primary' })
      return res.status(201).json(toThreadDto(thread))
    }),
  )

  // PATCH /api/support/threads/:threadId — body { status: 'closed' }, return updated thread
  router.patch(
    '/api/support/threads/:threadId',
    requireAuth,
    asyncHandler(async (req, res) => {
      const r = await tryResolveAuthUser(req)
      const { userPublicId, userMongoId, role } = getAuthIds(r)
      const threadIdRaw = typeof req.params?.threadId === 'string' ? req.params.threadId.trim() : ''
      const status = typeof req.body?.status === 'string' ? req.body.status.trim() : ''
      if (!threadIdRaw) return res.status(400).json({ error: 'missing_threadId' })
      if (status !== 'closed') return res.status(400).json({ error: 'invalid_status' })

      let threadOid = null
      try {
        threadOid = new mongoose.Types.ObjectId(threadIdRaw)
      } catch {
        return res.status(400).json({ error: 'bad_thread_id' })
      }

      const conn = await connectMongo()
      if (!conn?.enabled || mongoose.connection.readyState !== 1) {
        return res.status(500).json({ error: 'mongo_not_available' })
      }
      const db = mongoose.connection.db
      if (!db) return res.status(500).json({ error: 'mongo_not_available' })

      const threads = db.collection('supportThreads')
      const thread = await threads.findOne({ _id: threadOid }, { readPreference: 'primary' })
      if (!thread) return res.status(404).json({ error: 'thread_not_found' })

      const isOwner =
        thread.userId === userMongoId ||
        thread.userId === userPublicId ||
        String(thread.userId) === String(req.user?.id ?? '')
      if (role !== 'arbiter' && !isOwner) {
        return res.status(403).json({ error: 'forbidden' })
      }

      const now = new Date()
      const closedByUserId = userPublicId || userMongoId
      await threads.updateOne(
        { _id: threadOid },
        { $set: { status: 'closed', closedAt: now, closedByUserId, updatedAt: now } },
      )
      const updated = await threads.findOne({ _id: threadOid }, { readPreference: 'primary' })

      let userFullName = ''
      if (updated?.userId) {
        const parsed = parseUserId(updated.userId)
        if (parsed) {
          const users = db.collection('users')
          const userQuery =
            parsed.kind === 'tg'
              ? { telegramUserId: parsed.telegramUserId }
              : { _id: parsed._id }
          const userDoc = await users.findOne(userQuery, {
            projection: { fullName: 1, firstName: 1, lastName: 1, username: 1 },
            readPreference: 'primary',
          })
          if (userDoc) userFullName = fullNameFromUserDoc(userDoc)
        }
      }
      return res.json(toThreadDto(updated, userFullName))
    }),
  )

  // POST /api/support/threads/:threadId/rate — body { rating, comment? }, return updated thread
  router.post(
    '/api/support/threads/:threadId/rate',
    requireAuth,
    asyncHandler(async (req, res) => {
      const r = await tryResolveAuthUser(req)
      const { userPublicId, userMongoId, role } = getAuthIds(r)
      const threadIdRaw = typeof req.params?.threadId === 'string' ? req.params.threadId.trim() : ''
      const rating = req.body?.rating != null ? Number(req.body.rating) : null
      const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : null
      if (!threadIdRaw) return res.status(400).json({ error: 'missing_threadId' })
      if (rating == null || Number.isNaN(rating)) return res.status(400).json({ error: 'missing_rating' })

      let threadOid = null
      try {
        threadOid = new mongoose.Types.ObjectId(threadIdRaw)
      } catch {
        return res.status(400).json({ error: 'bad_thread_id' })
      }

      const conn = await connectMongo()
      if (!conn?.enabled || mongoose.connection.readyState !== 1) {
        return res.status(500).json({ error: 'mongo_not_available' })
      }
      const db = mongoose.connection.db
      if (!db) return res.status(500).json({ error: 'mongo_not_available' })

      const threads = db.collection('supportThreads')
      const thread = await threads.findOne({ _id: threadOid }, { readPreference: 'primary' })
      if (!thread) return res.status(404).json({ error: 'thread_not_found' })

      const isOwner =
        thread.userId === userMongoId ||
        thread.userId === userPublicId ||
        String(thread.userId) === String(req.user?.id ?? '')
      if (!isOwner) {
        return res.status(403).json({ error: 'forbidden' })
      }

      const now = new Date()
      const update = { rating, ratedAt: now, updatedAt: now }
      if (comment !== null) update.ratingComment = comment
      await threads.updateOne({ _id: threadOid }, { $set: update })
      const updated = await threads.findOne({ _id: threadOid }, { readPreference: 'primary' })

      let userFullName = ''
      if (updated?.userId) {
        const parsed = parseUserId(updated.userId)
        if (parsed) {
          const users = db.collection('users')
          const userQuery =
            parsed.kind === 'tg'
              ? { telegramUserId: parsed.telegramUserId }
              : { _id: parsed._id }
          const userDoc = await users.findOne(userQuery, {
            projection: { fullName: 1, firstName: 1, lastName: 1, username: 1 },
            readPreference: 'primary',
          })
          if (userDoc) userFullName = fullNameFromUserDoc(userDoc)
        }
      }
      return res.json(toThreadDto(updated, userFullName))
    }),
  )

  // GET /api/support/threads/:threadId/messages — list messages of the thread. Allowed for arbiter or thread owner.
  router.get(
    '/api/support/threads/:threadId/messages',
    requireAuth,
    asyncHandler(async (req, res) => {
      const r = await tryResolveAuthUser(req)
      const { role } = getAuthIds(r)
      const threadIdRaw = typeof req.params?.threadId === 'string' ? req.params.threadId.trim() : ''
      if (!threadIdRaw) return res.status(400).json({ error: 'missing_threadId' })

      let threadOid = null
      try {
        threadOid = new mongoose.Types.ObjectId(threadIdRaw)
      } catch {
        return res.status(400).json({ error: 'bad_thread_id' })
      }

      const conn = await connectMongo()
      if (!conn?.enabled || mongoose.connection.readyState !== 1) {
        return res.status(500).json({ error: 'mongo_not_available' })
      }
      const db = mongoose.connection.db
      if (!db) return res.status(500).json({ error: 'mongo_not_available' })

      const threads = db.collection('supportThreads')
      const messages = db.collection('supportMessages')

      const thread = await threads.findOne({ _id: threadOid }, { readPreference: 'primary' })
      if (!thread) return res.status(404).json({ error: 'thread_not_found' })

      const { userPublicId, userMongoId } = getAuthIds(r)
      const isOwner =
        thread.userId === userMongoId ||
        thread.userId === userPublicId ||
        String(thread.userId) === String(req.user?.id ?? '')
      if (role !== 'arbiter' && !isOwner) {
        return res.status(403).json({ error: 'forbidden' })
      }

      const list = await messages
        .find({ threadId: threadOid })
        .sort({ createdAt: 1 })
        .limit(1000)
        .toArray()

      return res.json(list.map(toMessageDto))
    }),
  )

  // POST /api/support/threads/:threadId/messages — body { fromUserId, text, telegramUserId? }, save message, notify arbiters
  router.post(
    '/api/support/threads/:threadId/messages',
    requireAuth,
    asyncHandler(async (req, res) => {
      const r = await tryResolveAuthUser(req)
      const { userPublicId, userMongoId, role } = getAuthIds(r)
      const threadIdRaw = typeof req.params?.threadId === 'string' ? req.params.threadId.trim() : ''
      const fromUserId = typeof req.body?.fromUserId === 'string' ? req.body.fromUserId.trim() : ''
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
      const bodyTelegramUserId = typeof req.body?.telegramUserId === 'string' ? req.body.telegramUserId.trim() : null
      const attachmentUrls = Array.isArray(req.body?.attachmentUrls)
        ? req.body.attachmentUrls.filter((u) => typeof u === 'string').slice(0, 20)
        : []

      if (!threadIdRaw) return res.status(400).json({ error: 'missing_threadId' })
      if (!fromUserId) return res.status(400).json({ error: 'missing_fromUserId' })

      const isSenderSelf =
        fromUserId === userMongoId ||
        fromUserId === userPublicId ||
        String(fromUserId) === String(req.user?.id ?? '') ||
        (bodyTelegramUserId &&
          String(r.user?.telegramUserId ?? '') === bodyTelegramUserId &&
          (fromUserId === userMongoId || fromUserId === userPublicId))
      if (role !== 'arbiter' && !isSenderSelf) {
        return res.status(403).json({ error: 'forbidden' })
      }

      let threadOid = null
      try {
        threadOid = new mongoose.Types.ObjectId(threadIdRaw)
      } catch {
        return res.status(400).json({ error: 'bad_thread_id' })
      }

      const conn = await connectMongo()
      if (!conn?.enabled || mongoose.connection.readyState !== 1) {
        return res.status(500).json({ error: 'mongo_not_available' })
      }
      const db = mongoose.connection.db
      if (!db) return res.status(500).json({ error: 'mongo_not_available' })

      const threads = db.collection('supportThreads')
      const messages = db.collection('supportMessages')
      const users = db.collection('users')

      const thread = await threads.findOne({ _id: threadOid }, { readPreference: 'primary' })
      if (!thread) return res.status(404).json({ error: 'thread_not_found' })

      const now = new Date()
      const insertRes = await messages.insertOne({
        threadId: threadOid,
        fromUserId,
        text: text || '',
        attachmentUrls,
        createdAt: now,
      })
      await threads.updateOne({ _id: threadOid }, { $set: { updatedAt: now } })

      const messageDoc = await messages.findOne({ _id: insertRes.insertedId }, { readPreference: 'primary' })

      // Notify arbiters so they see new support messages in support-inbox
      const arbiters = await users
        .find({ role: 'arbiter' }, { projection: { _id: 1 }, readPreference: 'primary' })
        .toArray()
      const textPreview = text.length > 80 ? text.slice(0, 77) + '...' : text
      const notificationText = `Новое обращение в поддержку: ${textPreview || '(без текста)'}`
      for (const arb of arbiters) {
        const arbId = String(arb._id)
        try {
          await createNotification(db, arbId, notificationText, {
            type: 'support_message',
            threadId: threadIdRaw,
            fromUserId,
            userId: thread.userId,
          })
        } catch {
          // ignore per-arbiter failure
        }
      }

      return res.status(201).json(toMessageDto(messageDoc))
    }),
  )

  return router
}
