import express from 'express'
import mongoose from 'mongoose'
import { tryResolveAuthUser } from './authSession.js'
import { freezeEscrow } from './escrowService.js'
import { canExecutorRespond } from './executorSanctionsService.js'

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isLocalizedText(v) {
  if (!isObject(v)) return false
  return typeof v.en === 'string' && typeof v.ru === 'string'
}

function toLocalizedText(v) {
  if (isLocalizedText(v)) {
    const en = v.en.trim()
    const ru = v.ru.trim()
    return { en, ru }
  }
  if (typeof v === 'string') {
    const s = v.trim()
    return { en: s, ru: s }
  }
  return null
}

function hasAnyText(lt) {
  if (!lt) return false
  return Boolean(String(lt.en || '').trim() || String(lt.ru || '').trim())
}

function clampInt(value, { min = 1, max = 10, fallback = 1 } = {}) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function trimOrNull(v) {
  return typeof v === 'string' ? (v.trim() ? v.trim() : null) : null
}

function calcExpiresAt(now) {
  // Default TTL for marketplace tasks: 24h (frontend uses the same constant in storage).
  return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
}

function normalizeDeliverables(v) {
  if (!Array.isArray(v)) return undefined
  const out = v
    .map((x) => {
      if (!isObject(x)) return null
      const platform = typeof x.platform === 'string' ? x.platform.trim() : ''
      const quantityRaw = typeof x.quantity === 'number' && Number.isFinite(x.quantity) ? Math.floor(x.quantity) : NaN
      const quantity = Number.isFinite(quantityRaw) ? Math.max(1, Math.min(50, quantityRaw)) : 1
      if (!platform) return null
      return { platform, quantity }
    })
    .filter(Boolean)
  return out.length ? out : undefined
}

function normalizeReference(v) {
  if (!isObject(v)) return undefined
  const kind = v.kind
  if (kind === 'url') {
    const url = typeof v.url === 'string' ? v.url.trim() : ''
    if (!url) return undefined
    return { kind: 'url', url }
  }
  if (kind === 'video') {
    const blobId = typeof v.blobId === 'string' ? v.blobId.trim() : ''
    const name = typeof v.name === 'string' ? v.name.trim() : ''
    const mimeType = typeof v.mimeType === 'string' && v.mimeType.trim() ? v.mimeType.trim() : undefined
    if (!blobId || !name) return undefined
    return { kind: 'video', blobId, name, mimeType }
  }
  if (kind === 'videos') {
    const videos = Array.isArray(v.videos) ? v.videos : null
    if (!videos) return undefined
    const normalized = videos
      .map((x) => {
        if (!isObject(x)) return null
        const blobId = typeof x.blobId === 'string' ? x.blobId.trim() : ''
        const name = typeof x.name === 'string' ? x.name.trim() : ''
        const mimeType = typeof x.mimeType === 'string' && x.mimeType.trim() ? x.mimeType.trim() : undefined
        if (!blobId || !name) return null
        return { blobId, name, mimeType }
      })
      .filter(Boolean)
    if (!normalized.length) return undefined
    return { kind: 'videos', videos: normalized.slice(0, 3) }
  }
  return undefined
}

function normalizeDescriptionFiles(v) {
  if (!Array.isArray(v)) return undefined
  const normalized = v
    .map((x) => {
      if (!isObject(x)) return null
      const name = typeof x.name === 'string' ? x.name.trim() : ''
      const text = typeof x.text === 'string' ? x.text : ''
      if (!name || !text) return null
      return { name, text }
    })
    .filter(Boolean)
  return normalized.length ? normalized.slice(0, 3) : undefined
}

function toTaskDto(doc) {
  if (!doc) return null
  const {
    _id,
    createdAt,
    updatedAt,
    completedAt,
    publishedAt,
    takenAt,
    reviewSubmittedAt,
    ...rest
  } = doc
  const createdByUserId = rest.createdByUserId ?? rest.userId ?? null
  return {
    id: String(_id),
    createdByUserId,
    createdByMongoId: rest.createdByMongoId ?? null,
    status: rest.status ?? 'draft',
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
    publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
    takenAt: takenAt ? new Date(takenAt).toISOString() : null,
    completedAt: completedAt ? new Date(completedAt).toISOString() : null,
    reviewSubmittedAt: reviewSubmittedAt ? new Date(reviewSubmittedAt).toISOString() : null,
    ...rest,
    // Backward compatibility: some older endpoints used userId as owner.
    userId: createdByUserId,
    assignedExecutorIds: Array.isArray(rest.assignedExecutorIds) ? rest.assignedExecutorIds : [],
    maxExecutors:
      typeof rest.maxExecutors === 'number' && Number.isFinite(rest.maxExecutors) && rest.maxExecutors > 0
        ? Math.max(1, Math.floor(rest.maxExecutors))
        : 1,
  }
}

export function createTasksApi() {
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  // Soft auth list: return [] if not logged in (prevents retry storms).
  router.get('/api/tasks', async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.json([])
    const userMongoId = String(r.userId)
    const telegramUserId =
      typeof r.user?.telegramUserId === 'string' && r.user.telegramUserId ? r.user.telegramUserId : null
    const userPublicId = telegramUserId ? `tg_${telegramUserId}` : userMongoId
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const tasks = db.collection('tasks')
    let query = null
    if (role === 'customer') {
      query = {
        $or: [
          // New canonical owner fields
          { createdByMongoId: userMongoId },
          { createdByUserId: userPublicId },
          // Backward-compatible legacy ownership fields
          { createdByUserId: userMongoId },
          { userId: userMongoId },
          { userId: userPublicId },
        ],
      }
    } else if (role === 'executor') {
      query = {
        $or: [
          // Marketplace: published tasks that still have free executor slots.
          {
            $and: [
              { publishedAt: { $ne: null } },
              { status: { $in: ['open', 'in_progress', 'review', 'dispute'] } },
              {
                $expr: {
                  $lt: [
                    { $size: { $ifNull: ['$assignedExecutorIds', []] } },
                    { $ifNull: ['$maxExecutors', 1] },
                  ],
                },
              },
            ],
          },
          { assignedExecutorIds: { $in: [userPublicId, userMongoId] } },
          { assignedToUserId: { $in: [userPublicId, userMongoId] } },
        ],
      }
    } else {
      query = { _id: null } // empty
    }

    const items = await tasks.find(query).sort({ createdAt: -1 }).limit(200).toArray()

    res.json(items.map(toTaskDto))
  })

  router.post('/api/tasks', async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const userMongoId = String(r.userId)
    const telegramUserId =
      typeof r.user?.telegramUserId === 'string' && r.user.telegramUserId ? r.user.telegramUserId : null
    const userPublicId = telegramUserId ? `tg_${telegramUserId}` : userMongoId
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })

    const now = new Date()

    const title = toLocalizedText(req.body?.title)
    if (!hasAnyText(title)) return res.status(400).json({ error: 'missing_title' })

    const description = toLocalizedText(req.body?.description)
    const shortDescription = toLocalizedText(req.body?.shortDescription)
    const requirements = toLocalizedText(req.body?.requirements)

    const category = trimOrNull(req.body?.category)
    const location = trimOrNull(req.body?.location)
    const dueDate = trimOrNull(req.body?.dueDate)
    const expiresAt = (() => {
      const v = trimOrNull(req.body?.expiresAt)
      return v || calcExpiresAt(now)
    })()

    const budgetAmount =
      typeof req.body?.budgetAmount === 'number' && Number.isFinite(req.body.budgetAmount) ? req.body.budgetAmount : null
    const budgetCurrency = trimOrNull(req.body?.budgetCurrency)

    const maxExecutors = clampInt(req.body?.maxExecutors, { min: 1, max: 50, fallback: 1 })

    const executorMode =
      req.body?.executorMode === 'blogger_ad' || req.body?.executorMode === 'customer_post' || req.body?.executorMode === 'ai'
        ? req.body.executorMode
        : 'customer_post'

    const deliverables = normalizeDeliverables(req.body?.deliverables)
    const reference = normalizeReference(req.body?.reference)
    const descriptionFiles = normalizeDescriptionFiles(req.body?.descriptionFiles)
    const descriptionFile = isObject(req.body?.descriptionFile) ? req.body.descriptionFile : null
    const lockedAfterPublish =
      typeof req.body?.lockedAfterPublish === 'boolean' ? req.body.lockedAfterPublish : undefined
    const editWindowExpiresAt = trimOrNull(req.body?.editWindowExpiresAt)

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const tasks = db.collection('tasks')
    const insertRes = await tasks.insertOne({
      createdByMongoId: userMongoId,
      createdByUserId: userPublicId,
      title,
      shortDescription,
      description,
      requirements,
      descriptionFiles,
      // Legacy single-file shape (keep if provided; also self-heal from array).
      descriptionFile: descriptionFiles?.length ? descriptionFiles[0] : descriptionFile,
      reference,
      executorMode,
      deliverables,
      category,
      location,
      budgetAmount,
      budgetCurrency,
      dueDate,
      expiresAt,
      maxExecutors,
      assignedExecutorIds: [],
      status: 'draft',
      lockedAfterPublish,
      editWindowExpiresAt,
      publishedAt: null,
      takenAt: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      reviewSubmittedAt: null,
    })

    const doc = await tasks.findOne({ _id: insertRes.insertedId })
    res.status(201).json(toTaskDto(doc))
  })

  router.post('/api/tasks/:taskId/publish', async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const userMongoId = String(r.userId)
    const telegramUserId =
      typeof r.user?.telegramUserId === 'string' && r.user.telegramUserId ? r.user.telegramUserId : null
    const userPublicId = telegramUserId ? `tg_${telegramUserId}` : userMongoId
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.taskId))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_task_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const tasks = db.collection('tasks')
    const existing = await tasks.findOne(
      {
        _id: oid,
        $or: [
          { createdByMongoId: userMongoId },
          { createdByUserId: userPublicId },
          // legacy
          { createdByUserId: userMongoId },
          { userId: userMongoId },
          { userId: userPublicId },
        ],
      },
      { readPreference: 'primary' },
    )
    if (!existing) return res.status(404).json({ error: 'not_found' })

    const currentStatus = typeof existing.status === 'string' && existing.status ? existing.status : 'draft'
    if (currentStatus === 'open') {
      return res.json(toTaskDto(existing))
    }
    if (currentStatus !== 'draft') {
      return res.status(409).json({ error: 'invalid_status', status: currentStatus })
    }

    const now = new Date()
    await tasks.updateOne(
      {
        _id: oid,
        $or: [
          { createdByMongoId: userMongoId },
          { createdByUserId: userPublicId },
          // legacy
          { createdByUserId: userMongoId },
          { userId: userMongoId },
          { userId: userPublicId },
        ],
      },
      { $set: { status: 'open', publishedAt: now, updatedAt: now } },
    )
    const doc = await tasks.findOne({ _id: oid }, { readPreference: 'primary' })
    return res.json(toTaskDto(doc))
  })

  router.post('/api/tasks/:taskId/take', async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const userMongoId = String(r.userId)
    const telegramUserId =
      typeof r.user?.telegramUserId === 'string' && r.user.telegramUserId ? r.user.telegramUserId : null
    const userPublicId = telegramUserId ? `tg_${telegramUserId}` : userMongoId
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'executor') return res.status(403).json({ error: 'forbidden' })

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.taskId))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_task_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const tasks = db.collection('tasks')
    const contracts = db.collection('contracts')
    const assignments = db.collection('assignments')

    // Enforce server-side sanctions: banned/blocked executors can't take tasks.
    const respondGuard = await canExecutorRespond(db, userPublicId, Date.now())
    if (!respondGuard.ok) {
      return res.status(403).json({
        error: respondGuard.reason === 'banned' ? 'executor_banned' : 'respond_blocked',
        reason: respondGuard.reason,
        until: respondGuard.until,
      })
    }

    const existing = await tasks.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!existing) return res.status(404).json({ error: 'not_found' })
    const status = typeof existing.status === 'string' && existing.status ? existing.status : 'draft'
    if (status !== 'open' && status !== 'in_progress') return res.status(409).json({ error: 'not_open', status })
    if (!existing.publishedAt) return res.status(409).json({ error: 'not_published' })

    const assigned = Array.isArray(existing.assignedExecutorIds) ? existing.assignedExecutorIds : []
    const maxExecutors =
      typeof existing.maxExecutors === 'number' && Number.isFinite(existing.maxExecutors) && existing.maxExecutors > 0
        ? Math.max(1, Math.floor(existing.maxExecutors))
        : 1
    if (assigned.includes(userPublicId) || assigned.includes(userMongoId)) return res.json(toTaskDto(existing))
    if (assigned.length >= maxExecutors) return res.status(409).json({ error: 'no_slots' })

    const now = new Date()

    // Freeze escrow from customer to allow taking the task.
    const amount =
      typeof existing.budgetAmount === 'number' && Number.isFinite(existing.budgetAmount) && existing.budgetAmount >= 0
        ? existing.budgetAmount
        : 0
    const customerId =
      typeof existing.createdByUserId === 'string' && existing.createdByUserId ? existing.createdByUserId : null
    if (customerId) {
      const fr = await freezeEscrow({
        db,
        balanceRepo: req.app?.locals?.balanceRepo,
        taskId: String(existing._id),
        contractId: null,
        customerId,
        customerMongoId: typeof existing.createdByMongoId === 'string' && existing.createdByMongoId ? existing.createdByMongoId : null,
        executorId: userPublicId,
        executorMongoId: userMongoId,
        amount,
      })
      if (!fr.ok) {
        if (fr.error === 'insufficient_balance') return res.status(409).json({ error: 'insufficient_balance', required: fr.required, balance: fr.balance })
        return res.status(500).json({ error: 'escrow_freeze_failed' })
      }
    }

    await tasks.updateOne(
      { _id: oid },
      {
        $addToSet: { assignedExecutorIds: userPublicId },
        $set: { status: 'in_progress', takenAt: existing.takenAt ?? now, updatedAt: now },
      },
    )

    // Best-effort: create contract + assignment for downstream UI flows.
    // Contract client is task owner (public id), executor is current user (public id).
    const clientId = customerId
    const clientMongoId =
      typeof existing.createdByMongoId === 'string' && existing.createdByMongoId ? existing.createdByMongoId : null
    const taskId = String(existing._id)

    let contractId = null
    try {
      const up = await contracts.findOneAndUpdate(
        { taskId, executorId: userPublicId },
        {
          $setOnInsert: {
            taskId,
            clientId,
            clientMongoId,
            executorId: userPublicId,
            executorMongoId: userMongoId,
            escrowAmount:
              typeof existing.budgetAmount === 'number' && Number.isFinite(existing.budgetAmount) && existing.budgetAmount >= 0
                ? existing.budgetAmount
                : 0,
            status: 'active',
            revisionIncluded: 2,
            revisionUsed: 0,
            createdAt: now,
          },
          $set: { updatedAt: now },
        },
        { upsert: true, returnDocument: 'after' },
      )
      const doc = up?.value ?? up
      contractId = doc?._id ? String(doc._id) : null
    } catch {
      contractId = null
    }
    if (contractId) {
      await db.collection('escrows').updateOne({ taskId, executorId: userPublicId }, { $set: { contractId, updatedAt: now } })
    }

    const assignedAt = now.toISOString()
    const startDeadlineAt = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString()
    try {
      await assignments.updateOne(
        { taskId, executorId: userPublicId },
        {
          $setOnInsert: {
            taskId,
            executorId: userPublicId,
            executorMongoId: userMongoId,
            assignedAt,
            startDeadlineAt,
            status: 'pending_start',
            createdAt: now,
          },
          $set: { updatedAt: now, contractId },
        },
        { upsert: true },
      )
    } catch {
      // ignore
    }

    const doc = await tasks.findOne({ _id: oid }, { readPreference: 'primary' })
    return res.json(toTaskDto(doc))
  })

  router.patch('/api/tasks/:id', async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const userMongoId = String(r.userId)
    const telegramUserId =
      typeof r.user?.telegramUserId === 'string' && r.user.telegramUserId ? r.user.telegramUserId : null
    const userPublicId = telegramUserId ? `tg_${telegramUserId}` : userMongoId
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.id))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_task_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const tasks = db.collection('tasks')

    const existing = await tasks.findOne(
      {
        _id: oid,
        $or: [
          { createdByMongoId: userMongoId },
          { createdByUserId: userPublicId },
          // legacy
          { createdByUserId: userMongoId },
          { userId: userMongoId },
          { userId: userPublicId },
        ],
      },
      { readPreference: 'primary' },
    )
    if (!existing) return res.status(404).json({ error: 'not_found' })

    const update = { $set: { updatedAt: new Date() } }
    if (req.body?.title !== undefined) {
      const t = toLocalizedText(req.body.title)
      if (t && hasAnyText(t)) update.$set.title = t
    }
    if (req.body?.shortDescription !== undefined) {
      const v = toLocalizedText(req.body.shortDescription)
      if (v) update.$set.shortDescription = v
    }
    if (req.body?.description !== undefined) {
      const v = toLocalizedText(req.body.description)
      if (v) update.$set.description = v
    }
    if (req.body?.requirements !== undefined) {
      const v = toLocalizedText(req.body.requirements)
      if (v) update.$set.requirements = v
    }
    if (req.body?.descriptionFiles !== undefined) {
      const files = normalizeDescriptionFiles(req.body.descriptionFiles)
      update.$set.descriptionFiles = files ?? null
      // Keep legacy field in sync.
      update.$set.descriptionFile = files?.[0] ?? null
    }
    if (req.body?.reference !== undefined) {
      update.$set.reference = normalizeReference(req.body.reference) ?? null
    }
    if (req.body?.deliverables !== undefined) {
      update.$set.deliverables = normalizeDeliverables(req.body.deliverables) ?? null
    }
    if (req.body?.executorMode !== undefined) {
      const m = req.body.executorMode
      if (m === 'blogger_ad' || m === 'customer_post' || m === 'ai') update.$set.executorMode = m
    }
    if (typeof req.body?.category === 'string') update.$set.category = req.body.category.trim()
    if (typeof req.body?.location === 'string') update.$set.location = req.body.location.trim()
    if (typeof req.body?.budgetAmount === 'number' && Number.isFinite(req.body.budgetAmount)) {
      update.$set.budgetAmount = req.body.budgetAmount
    }
    if (typeof req.body?.budgetCurrency === 'string') update.$set.budgetCurrency = req.body.budgetCurrency.trim()
    if (typeof req.body?.dueDate === 'string') update.$set.dueDate = req.body.dueDate.trim()
    if (typeof req.body?.expiresAt === 'string') update.$set.expiresAt = req.body.expiresAt.trim()
    if (typeof req.body?.maxExecutors === 'number' && Number.isFinite(req.body.maxExecutors)) {
      const me = Math.floor(req.body.maxExecutors)
      update.$set.maxExecutors = me > 0 ? me : 1
    }
    if (typeof req.body?.status === 'string') update.$set.status = req.body.status.trim()
    if (req.body?.completedAt === null) update.$set.completedAt = null
    if (typeof req.body?.completedAt === 'string' && req.body.completedAt.trim()) {
      const d = new Date(req.body.completedAt)
      if (!Number.isNaN(d.getTime())) update.$set.completedAt = d
    }

    await tasks.updateOne(
      {
        _id: oid,
        $or: [
          { createdByMongoId: userMongoId },
          { createdByUserId: userPublicId },
          // legacy
          { createdByUserId: userMongoId },
          { userId: userMongoId },
          { userId: userPublicId },
        ],
      },
      update,
    )
    const doc = await tasks.findOne({ _id: oid }, { readPreference: 'primary' })
    return res.json(toTaskDto(doc))
  })

  return router
}

