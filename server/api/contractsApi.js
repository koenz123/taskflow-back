import express from 'express'
import mongoose from 'mongoose'
import { tryResolveAuthUser } from '../auth/authSession.js'
import { releaseEscrowToExecutor, refundEscrowToCustomer } from '../services/escrowService.js'
import { createNotification } from '../services/notificationService.js'
import { inferLocale } from '../infra/locale.js'
import { currencyFromLocale, fromRub, round2 } from '../infra/money.js'
import { getUsdRubRate } from '../infra/usdRubRate.js'

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
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

function toDto(doc) {
  if (!doc) return null
  const { _id, createdAt, updatedAt, ...rest } = doc
  return {
    id: String(_id),
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
    ...rest,
  }
}

function withMoney(dto, { currency, usdRubRate }) {
  if (!dto) return dto
  const escrowRub = typeof dto.escrowAmount === 'number' && Number.isFinite(dto.escrowAmount) ? dto.escrowAmount : null
  if (escrowRub == null) return { ...dto, escrowCurrency: currency }
  const escrowAmount = currency === 'USD' ? fromRub(escrowRub, 'USD', usdRubRate) : round2(escrowRub)
  return {
    ...dto,
    escrowAmount,
    escrowCurrency: currency,
    escrowAmountRub: round2(escrowRub),
  }
}

function normalizeStatus(value) {
  if (
    value === 'active' ||
    value === 'submitted' ||
    value === 'revision_requested' ||
    value === 'approved' ||
    value === 'disputed' ||
    value === 'resolved' ||
    value === 'cancelled'
  ) {
    return value
  }
  return 'active'
}

async function recomputeTaskStatus({ db, taskId }) {
  const tasks = db.collection('tasks')
  const assignments = db.collection('assignments')
  const contracts = db.collection('contracts')

  let taskOid = null
  try {
    taskOid = new mongoose.Types.ObjectId(String(taskId))
  } catch {
    taskOid = null
  }
  if (!taskOid) return
  const task = await tasks.findOne({ _id: taskOid }, { readPreference: 'primary' })
  if (!task) return

  const list = await contracts.find({ taskId: String(taskId) }).toArray()
  const hasDispute = list.some((c) => c.status === 'disputed')
  const hasReview = list.some((c) => c.status === 'submitted')
  const hasActive = list.some((c) => c.status === 'active' || c.status === 'revision_requested')
  const allDone =
    list.length > 0 &&
    list.every((c) => c.status === 'approved' || c.status === 'resolved' || c.status === 'cancelled')

  const assignedCount = Array.isArray(task.assignedExecutorIds) ? task.assignedExecutorIds.length : 0
  const maxExecutors =
    typeof task.maxExecutors === 'number' && Number.isFinite(task.maxExecutors) && task.maxExecutors > 0
      ? Math.max(1, Math.floor(task.maxExecutors))
      : 1
  const hasSlots = assignedCount < maxExecutors

  const shouldClose = !hasSlots && allDone
  const next =
    shouldClose ? 'closed' : hasDispute ? 'dispute' : hasReview ? 'review' : hasActive || assignedCount > 0 ? 'in_progress' : 'open'

  const now = new Date()
  const set = { status: next, updatedAt: now }
  if (next === 'closed' && !task.completedAt) set.completedAt = now
  if (next !== 'closed' && task.completedAt) set.completedAt = null
  await tasks.updateOne({ _id: task._id }, { $set: set })

  // Keep assignment statuses in sync with contract status (best-effort).
  // We only touch assignments for this task, leaving executor action endpoints as the source of truth.
  const as = await assignments.find({ taskId: String(taskId) }).toArray()
  for (const a of as) {
    const c = list.find((x) => x.executorId === a.executorId) ?? null
    if (!c) continue
    if (c.status === 'submitted' && a.status !== 'submitted') {
      await assignments.updateOne({ _id: a._id }, { $set: { status: 'submitted', updatedAt: now } })
    } else if (c.status === 'revision_requested' && a.status !== 'in_progress') {
      await assignments.updateOne({ _id: a._id }, { $set: { status: 'in_progress', updatedAt: now } })
    } else if ((c.status === 'approved' || c.status === 'resolved') && a.status !== 'accepted') {
      await assignments.updateOne({ _id: a._id }, { $set: { status: 'accepted', acceptedAt: now.toISOString(), updatedAt: now } })
    } else if (c.status === 'disputed' && a.status !== 'dispute_opened') {
      await assignments.updateOne({ _id: a._id }, { $set: { status: 'dispute_opened', updatedAt: now } })
    }
  }
}

export function createContractsApi() {
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  // Soft auth list: return [] if not logged in.
  router.get('/api/contracts', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.json([])
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    const { userMongoId, userPublicId } = getAuthIds(r)
    const currency = currencyFromLocale(inferLocale(req))
    const usdRubRate = currency === 'USD' ? await getUsdRubRate({ dataDir: req.app?.locals?.dataDir }) : null

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const contracts = db.collection('contracts')
    const tasks = db.collection('tasks')

    if (role === 'executor') {
      const items = await contracts
        .find({ executorId: { $in: [userPublicId, userMongoId] } })
        .sort({ createdAt: -1 })
        .limit(500)
        .toArray()
      return res.json(items.map((x) => withMoney(toDto(x), { currency, usdRubRate })))
    }

    if (role === 'customer') {
      const ownedTasks = await tasks
        .find(
          {
            $or: [
              { createdByMongoId: userMongoId },
              { createdByUserId: userPublicId },
              { userId: userMongoId },
              { userId: userPublicId },
            ],
          },
          { projection: { _id: 1 }, readPreference: 'primary' },
        )
        .limit(500)
        .toArray()
      const taskIds = ownedTasks.map((t) => String(t._id))
      if (!taskIds.length) return res.json([])
      const items = await contracts.find({ taskId: { $in: taskIds } }).sort({ createdAt: -1 }).limit(500).toArray()
      return res.json(items.map((x) => withMoney(toDto(x), { currency, usdRubRate })))
    }

    return res.json([])
  }))

  // GET /api/contracts/:contractId — single contract (arbiter: any; executor/customer: own only).
  router.get('/api/contracts/:contractId', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    const { userMongoId, userPublicId } = getAuthIds(r)
    const currency = currencyFromLocale(inferLocale(req))
    const usdRubRate = currency === 'USD' ? await getUsdRubRate({ dataDir: req.app?.locals?.dataDir }) : null

    const contractIdRaw = typeof req.params?.contractId === 'string' ? req.params.contractId.trim() : ''
    if (!contractIdRaw) return res.status(400).json({ error: 'missing_contractId' })
    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(contractIdRaw)
    } catch {
      return res.status(400).json({ error: 'bad_contract_id' })
    }

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const contracts = db.collection('contracts')
    const contract = await contracts.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!contract) return res.status(404).json({ error: 'not_found' })

    if (role === 'arbiter') {
      return res.json(withMoney(toDto(contract), { currency, usdRubRate }))
    }
    if (role === 'executor' && (contract.executorId === userPublicId || contract.executorId === userMongoId)) {
      return res.json(withMoney(toDto(contract), { currency, usdRubRate }))
    }
    if (role === 'customer' && (contract.clientId === userPublicId || contract.clientId === userMongoId)) {
      return res.json(withMoney(toDto(contract), { currency, usdRubRate }))
    }
    return res.status(403).json({ error: 'forbidden' })
  }))

  // Customer requests revision on submitted work.
  router.post('/api/contracts/:contractId/request-revision', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.contractId))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_contract_id' })

    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
    if (!message) return res.status(400).json({ error: 'missing_message' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const contracts = db.collection('contracts')

    const contract = await contracts.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!contract) return res.status(404).json({ error: 'not_found' })
    const isOwner = contract.clientId === userPublicId || contract.clientId === userMongoId
    if (!isOwner) return res.status(403).json({ error: 'forbidden' })

    const status = normalizeStatus(contract.status)
    if (status !== 'submitted') return res.status(409).json({ error: 'invalid_status', status })

    const now = new Date()
    const revisionIncluded =
      typeof contract.revisionIncluded === 'number' && Number.isFinite(contract.revisionIncluded) ? Math.max(0, Math.floor(contract.revisionIncluded)) : 2
    const revisionUsed =
      typeof contract.revisionUsed === 'number' && Number.isFinite(contract.revisionUsed) ? Math.max(0, Math.floor(contract.revisionUsed)) : 0
    if (revisionUsed >= revisionIncluded) return res.status(409).json({ error: 'revision_limit' })

    await contracts.updateOne(
      { _id: oid },
      {
        $set: {
          status: 'revision_requested',
          lastRevisionMessage: message,
          lastRevisionRequestedAt: now.toISOString(),
          updatedAt: now,
        },
        $inc: { revisionUsed: 1 },
      },
    )

    // Best-effort notification to executor.
    try {
      const executorMongoId =
        typeof contract?.executorMongoId === 'string' && contract.executorMongoId
          ? contract.executorMongoId
          : await resolveMongoIdFromPublicId(db, contract?.executorId)
      const taskId = typeof contract?.taskId === 'string' ? contract.taskId : null
      if (executorMongoId && taskId) {
        await addNotification(db, executorMongoId, 'Заказчик отправил работу на доработку.', {
          type: 'task_revision_requested',
          taskId,
          actorUserId: userPublicId,
          message,
          contractId: String(contract._id),
        })
      }
    } catch {
      // ignore
    }

    if (contract.taskId) {
      await recomputeTaskStatus({ db, taskId: contract.taskId })
    }
    const fresh = await contracts.findOne({ _id: oid }, { readPreference: 'primary' })
    const currency = currencyFromLocale(inferLocale(req))
    const usdRubRate = currency === 'USD' ? await getUsdRubRate({ dataDir: req.app?.locals?.dataDir }) : null
    return res.json(withMoney(toDto(fresh), { currency, usdRubRate }))
  }))

  // Customer approves submitted work.
  router.post('/api/contracts/:contractId/approve', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.contractId))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_contract_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const contracts = db.collection('contracts')

    const contract = await contracts.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!contract) return res.status(404).json({ error: 'not_found' })
    const isOwner = contract.clientId === userPublicId || contract.clientId === userMongoId
    if (!isOwner) return res.status(403).json({ error: 'forbidden' })

    const status = normalizeStatus(contract.status)
    if (status !== 'submitted' && status !== 'disputed') return res.status(409).json({ error: 'invalid_status', status })

    const now = new Date()
    await contracts.updateOne({ _id: oid }, { $set: { status: 'approved', updatedAt: now } })

    // Escrow payout: release frozen amount to executor (idempotent).
    const taskId = typeof contract.taskId === 'string' ? contract.taskId : null
    const executorId = typeof contract.executorId === 'string' ? contract.executorId : null
    if (taskId && executorId) {
      await releaseEscrowToExecutor({
        db,
        balanceRepo: req.app?.locals?.balanceRepo,
        taskId,
        executorId,
      }).catch(() => {})
    }

    if (contract.taskId) {
      await recomputeTaskStatus({ db, taskId: contract.taskId })
    }
    const fresh = await contracts.findOne({ _id: oid }, { readPreference: 'primary' })
    const currency = currencyFromLocale(inferLocale(req))
    const usdRubRate = currency === 'USD' ? await getUsdRubRate({ dataDir: req.app?.locals?.dataDir }) : null
    return res.json(withMoney(toDto(fresh), { currency, usdRubRate }))
  }))

  // Customer cancels contract (e.g. "change executor"): remove executor from task, refund escrow, notify removed executor.
  router.post('/api/contracts/:contractId/cancel', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.contractId))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_contract_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const contracts = db.collection('contracts')
    const assignments = db.collection('assignments')
    const tasks = db.collection('tasks')
    const applications = db.collection('applications')

    const contract = await contracts.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!contract) return res.status(404).json({ error: 'not_found' })
    const isOwner = contract.clientId === userPublicId || contract.clientId === userMongoId
    if (!isOwner) return res.status(403).json({ error: 'forbidden' })

    const status = normalizeStatus(contract.status)
    if (status === 'cancelled' || status === 'approved' || status === 'resolved') {
      return res.status(409).json({ error: 'invalid_status', status })
    }

    const taskId = typeof contract.taskId === 'string' ? contract.taskId : null
    const executorId = typeof contract.executorId === 'string' ? contract.executorId : null
    if (!taskId || !executorId) return res.status(500).json({ error: 'bad_contract' })

    const now = new Date()

    await contracts.updateOne({ _id: oid }, { $set: { status: 'cancelled', updatedAt: now } })

    await assignments.updateOne(
      { taskId, executorId },
      { $set: { status: 'cancelled_by_customer', updatedAt: now } },
    )

    try {
      await tasks.updateOne(
        { _id: new mongoose.Types.ObjectId(taskId) },
        { $pull: { assignedExecutorIds: executorId }, $set: { updatedAt: now } },
      )
    } catch {
      // ignore
    }

    await refundEscrowToCustomer({
      db,
      balanceRepo: req.app?.locals?.balanceRepo,
      taskId,
      executorId,
    }).catch(() => {})

    await applications
      .updateOne(
        { taskId, executorUserId: executorId, status: 'selected' },
        { $set: { status: 'rejected', updatedAt: now } },
      )
      .catch(() => {})

    if (taskId) await recomputeTaskStatus({ db, taskId })

    // Notify removed executor (backend sends notification when executor is changed).
    const executorMongoId =
      typeof contract?.executorMongoId === 'string' && contract.executorMongoId
        ? contract.executorMongoId
        : await resolveMongoIdFromPublicId(db, executorId)
    if (executorMongoId) {
      await addNotification(db, executorMongoId, 'Вас сняли с задания. Заказчик выбрал другого исполнителя.', {
        type: 'task_assigned_else',
        taskId,
        actorUserId: userPublicId,
      })
    }

    const fresh = await contracts.findOne({ _id: oid }, { readPreference: 'primary' })
    const currency = currencyFromLocale(inferLocale(req))
    const usdRubRate = currency === 'USD' ? await getUsdRubRate({ dataDir: req.app?.locals?.dataDir }) : null
    return res.json(withMoney(toDto(fresh), { currency, usdRubRate }))
  }))

  return router
}

