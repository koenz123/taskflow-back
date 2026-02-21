import express from 'express'
import mongoose from 'mongoose'
import { tryResolveAuthUser } from './authSession.js'

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

function toDto(doc) {
  if (!doc) return null
  const { _id, createdAt, ...rest } = doc
  return {
    id: String(_id),
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    ...rest,
  }
}

function normalizeRatingValue(v) {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN
  if (!Number.isFinite(n)) return null
  if (n < 1 || n > 5) return null
  return n
}

function normalizeComment(v) {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s ? s.slice(0, 2000) : undefined
}

function normalizeContractId(v) {
  if (typeof v !== 'string') return ''
  return v.trim()
}

function normalizeUserId(v) {
  if (typeof v !== 'string') return ''
  return v.trim()
}

async function addNotification(db, userMongoId, text, meta = null) {
  try {
    if (!userMongoId) return
    const msg = String(text || '').trim()
    if (!msg) return
    await db.collection('notifications').insertOne({
      userId: String(userMongoId),
      text: msg,
      meta: meta && typeof meta === 'object' ? meta : null,
      createdAt: new Date(),
    })
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

async function loadContractById({ db, contractId }) {
  let oid = null
  try {
    oid = new mongoose.Types.ObjectId(String(contractId))
  } catch {
    oid = null
  }
  if (!oid) return { ok: false, error: 'bad_contract_id' }
  const contract = await db.collection('contracts').findOne({ _id: oid }, { readPreference: 'primary' })
  if (!contract) return { ok: false, error: 'not_found' }
  return { ok: true, contract }
}

function getContractParticipants(contract) {
  const clientId = typeof contract?.clientId === 'string' ? contract.clientId : null
  const executorId = typeof contract?.executorId === 'string' ? contract.executorId : null
  return { clientId, executorId }
}

function canRateContract(contractStatus) {
  // Rating is allowed only after work is completed or dispute is resolved.
  return contractStatus === 'approved' || contractStatus === 'resolved'
}

export function createRatingsApi() {
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  async function handleList(req, res) {
    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const contractId = normalizeContractId(req.query?.contractId)
    const toUserId = normalizeUserId(req.query?.toUserId)
    const fromUserId = normalizeUserId(req.query?.fromUserId)

    // Public listing is allowed only when explicitly filtered by recipient.
    // Otherwise require auth and scope to the current user to avoid dumping all ratings.
    const r = await tryResolveAuthUser(req)
    const authOk = r.ok
    const authIds = authOk ? getAuthIds(r) : null

    const ratings = db.collection('ratings')
    const query = {}

    if (toUserId) {
      query.toUserId = toUserId
    }
    if (fromUserId) {
      query.fromUserId = fromUserId
    }
    if (contractId) {
      query.contractId = contractId
    }

    const hasExplicitPublicFilter = Boolean(toUserId)
    if (!hasExplicitPublicFilter) {
      if (!authOk) return res.json([])
      // Default: only ratings visible to the current user (given or received).
      if (!contractId && !fromUserId && !toUserId) {
        query.$or = [{ fromUserId: authIds.userPublicId }, { toUserId: authIds.userPublicId }]
      } else {
        // If caller uses custom filters without toUserId, require that user is part of the slice.
        query.$and = [
          query,
          { $or: [{ fromUserId: authIds.userPublicId }, { toUserId: authIds.userPublicId }] },
        ]
        // Remove top-level props copied into $and object.
        delete query.fromUserId
        delete query.toUserId
        delete query.contractId
        delete query.$or
      }
    }

    const items = await ratings.find(query).sort({ createdAt: -1 }).limit(2000).toArray()
    return res.json(items.map(toDto))
  }

  async function handleUpsert(req, res, { contractIdOverride = null } = {}) {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'customer' && role !== 'executor') return res.status(403).json({ error: 'forbidden' })

    const { userMongoId, userPublicId } = getAuthIds(r)

    const contractId = contractIdOverride ?? normalizeContractId(req.body?.contractId)
    if (!contractId) return res.status(400).json({ error: 'missing_contractId' })

    const ratingValue = normalizeRatingValue(req.body?.rating)
    if (!ratingValue) return res.status(400).json({ error: 'invalid_rating' })

    const comment = normalizeComment(req.body?.comment)
    const requestedToUserId = normalizeUserId(req.body?.toUserId) || null

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const loaded = await loadContractById({ db, contractId })
    if (!loaded.ok) return res.status(loaded.error === 'not_found' ? 404 : 400).json({ error: loaded.error })
    const contract = loaded.contract

    const { clientId, executorId } = getContractParticipants(contract)
    if (!clientId || !executorId) return res.status(409).json({ error: 'bad_contract_shape' })

    const isExecutor = executorId === userPublicId || executorId === userMongoId
    const isCustomer = clientId === userPublicId || clientId === userMongoId
    if (!isExecutor && !isCustomer) return res.status(403).json({ error: 'forbidden' })

    const toUserId = isCustomer ? executorId : clientId
    if (requestedToUserId && requestedToUserId !== toUserId) {
      return res.status(400).json({ error: 'invalid_toUserId' })
    }

    const status = typeof contract.status === 'string' ? contract.status : null
    if (!canRateContract(status)) return res.status(409).json({ error: 'invalid_contract_status', status })

    const ratings = db.collection('ratings')
    const now = new Date()
    const up = await ratings.findOneAndUpdate(
      { contractId: String(contractId), fromUserId: userPublicId },
      {
        $setOnInsert: { createdAt: now },
        $set: {
          contractId: String(contractId),
          fromUserId: userPublicId,
          toUserId,
          rating: ratingValue,
          comment: comment ?? undefined,
          updatedAt: now,
        },
      },
      { upsert: true, returnDocument: 'after' },
    )
    const doc = up?.value ?? up
    // Best-effort: notify recipient about new/updated rating.
    try {
      const taskId = typeof contract?.taskId === 'string' ? contract.taskId : null
      const recipientMongoId =
        isCustomer
          ? (typeof contract?.executorMongoId === 'string' && contract.executorMongoId
              ? contract.executorMongoId
              : await resolveMongoIdFromPublicId(db, contract?.executorId))
          : (typeof contract?.clientMongoId === 'string' && contract.clientMongoId
              ? contract.clientMongoId
              : await resolveMongoIdFromPublicId(db, contract?.clientId))
      if (recipientMongoId && taskId && doc?._id) {
        await addNotification(db, recipientMongoId, 'Вам поставили оценку.', {
          type: isCustomer ? 'rating_received_executor' : 'rating_received_customer',
          taskId,
          contractId: String(contract._id),
          actorUserId: userPublicId,
          ratingId: String(doc._id),
        })
      }
    } catch {
      // ignore
    }
    return res.status(201).json(toDto(doc))
  }

  // Canonical endpoints
  router.get('/api/ratings', asyncHandler(handleList))
  router.post('/api/ratings', asyncHandler((req, res) => handleUpsert(req, res)))

  // Aliases for frontend fallbacks
  router.get('/api/reviews', asyncHandler(handleList))
  router.post('/api/reviews', asyncHandler((req, res) => handleUpsert(req, res)))

  // Contract-scoped aliases
  router.post('/api/contracts/:contractId/rating', asyncHandler((req, res) => handleUpsert(req, res, { contractIdOverride: req.params.contractId })))
  router.post('/api/contracts/:contractId/rate', asyncHandler((req, res) => handleUpsert(req, res, { contractIdOverride: req.params.contractId })))

  return router
}

