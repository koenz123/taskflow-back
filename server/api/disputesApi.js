import express from 'express'
import mongoose from 'mongoose'
import { tryResolveAuthUser } from '../auth/authSession.js'
import { refundEscrowToCustomer, releaseEscrowToExecutor, splitEscrow } from '../services/escrowService.js'
import { createNotification } from '../services/notificationService.js'
import { inferLocale } from '../infra/locale.js'
import { currencyFromLocale, round2, toRub } from '../infra/money.js'
import { getUsdRubRate } from '../infra/usdRubRate.js'

const SLA_MS = 24 * 60 * 60 * 1000

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

function addMsToIso(iso, addMs) {
  const ts = Date.parse(String(iso))
  const base = Number.isFinite(ts) ? ts : Date.now()
  return new Date(base + addMs).toISOString()
}

function normalizeReason(value) {
  if (!isObject(value)) return { categoryId: 'universal', reasonId: 'other' }
  const categoryId = typeof value.categoryId === 'string' && value.categoryId.trim() ? value.categoryId.trim() : 'universal'
  const reasonId = typeof value.reasonId === 'string' && value.reasonId.trim() ? value.reasonId.trim() : 'other'
  const detail = typeof value.detail === 'string' && value.detail.trim() ? value.detail.trim() : undefined
  return { categoryId, reasonId, detail }
}

function normalizeDecision(value) {
  if (!isObject(value)) return null
  const payout = value.payout
  if (payout === 'executor') return { payout: 'executor' }
  if (payout === 'customer') return { payout: 'customer' }
  if (payout === 'split' || payout === 'partial') {
    const executorAmount = typeof value.executorAmount === 'number' ? value.executorAmount : NaN
    const customerAmount = typeof value.customerAmount === 'number' ? value.customerAmount : NaN
    if (!Number.isFinite(executorAmount) || !Number.isFinite(customerAmount)) return null
    const note = typeof value.note === 'string' && value.note.trim() ? value.note.trim() : undefined
    return payout === 'split'
      ? { payout: 'split', executorAmount, customerAmount }
      : { payout: 'partial', executorAmount, customerAmount, note }
  }
  return null
}

function toDto(doc) {
  if (!doc) return null
  const { _id, createdAt, updatedAt, contractId, openedByUserId, status, lockedDecisionAt, assignedArbiterId, version, ...rest } = doc
  return {
    id: String(_id),
    _id: String(_id),
    contractId: contractId != null ? String(contractId) : undefined,
    openedByUserId: openedByUserId ?? undefined,
    status: status ?? 'open',
    lockedDecisionAt: lockedDecisionAt ? new Date(lockedDecisionAt).toISOString() : null,
    assignedArbiterId: assignedArbiterId ?? null,
    version: version != null ? Number(version) : undefined,
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
    ...rest,
  }
}

async function getContractAccess({ db, contractId, userPublicId, userMongoId }) {
  let oid = null
  try {
    oid = new mongoose.Types.ObjectId(String(contractId))
  } catch {
    oid = null
  }
  if (!oid) return { ok: false, error: 'bad_contract_id' }
  const contracts = db.collection('contracts')
  const contract = await contracts.findOne({ _id: oid }, { readPreference: 'primary' })
  if (!contract) return { ok: false, error: 'contract_not_found' }
  const isExecutor = contract.executorId === userPublicId || contract.executorId === userMongoId
  const isCustomer = contract.clientId === userPublicId || contract.clientId === userMongoId
  return { ok: true, contract, isExecutor, isCustomer }
}

async function listAccessibleDisputes({ db, role, userPublicId, userMongoId }) {
  const disputes = db.collection('disputes')
  if (role === 'arbiter') {
    const items = await disputes.find({}).sort({ updatedAt: -1 }).limit(500).toArray()
    return items
  }
  if (role === 'executor') {
    const items = await disputes
      .find({ $or: [{ executorId: userPublicId }, { executorId: userMongoId }] })
      .sort({ updatedAt: -1 })
      .limit(500)
      .toArray()
    return items
  }
  if (role === 'customer') {
    const items = await disputes
      .find({ $or: [{ customerId: userPublicId }, { customerId: userMongoId }] })
      .sort({ updatedAt: -1 })
      .limit(500)
      .toArray()
    return items
  }
  return []
}

export function createDisputesApi() {
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  router.get('/api/disputes', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.json([])
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    const { userMongoId, userPublicId } = getAuthIds(r)

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const contractId = typeof req.query?.contractId === 'string' ? req.query.contractId.trim() : ''
    if (contractId) {
      const items = await db.collection('disputes').find({ contractId }).sort({ updatedAt: -1 }).limit(50).toArray()
      // Filter to accessible by embedded ids
      const allowed = items.filter((d) => {
        if (role === 'arbiter') return true
        if (role === 'executor') return d.executorId === userPublicId || d.executorId === userMongoId
        if (role === 'customer') return d.customerId === userPublicId || d.customerId === userMongoId
        return false
      })
      return res.json(allowed.map(toDto))
    }

    const items = await listAccessibleDisputes({ db, role, userPublicId, userMongoId })
    return res.json(items.map(toDto))
  }))

  // GET /api/disputes/:disputeId — single dispute by id (arbiter: any; executor/customer: own only).
  router.get('/api/disputes/:disputeId', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    const { userMongoId, userPublicId } = getAuthIds(r)

    const disputeIdRaw = typeof req.params?.disputeId === 'string' ? req.params.disputeId.trim() : ''
    if (!disputeIdRaw) return res.status(400).json({ error: 'missing_disputeId' })
    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(disputeIdRaw)
    } catch {
      return res.status(400).json({ error: 'bad_dispute_id' })
    }

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const disputes = db.collection('disputes')
    const dispute = await disputes.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!dispute) return res.status(404).json({ error: 'not_found' })

    if (role === 'arbiter') return res.json(toDto(dispute))
    if (role === 'executor' && (dispute.executorId === userPublicId || dispute.executorId === userMongoId)) {
      return res.json(toDto(dispute))
    }
    if (role === 'customer' && (dispute.customerId === userPublicId || dispute.customerId === userMongoId)) {
      return res.json(toDto(dispute))
    }
    return res.status(403).json({ error: 'forbidden' })
  }))

  // Open dispute (customer or executor).
  router.post('/api/disputes', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    const { userMongoId, userPublicId } = getAuthIds(r)
    if (role !== 'customer' && role !== 'executor') return res.status(403).json({ error: 'forbidden' })

    const contractId = typeof req.body?.contractId === 'string' ? req.body.contractId.trim() : ''
    if (!contractId) return res.status(400).json({ error: 'missing_contractId' })
    const reason = normalizeReason(req.body?.reason)

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const access = await getContractAccess({ db, contractId, userPublicId, userMongoId })
    if (!access.ok) return res.status(access.error === 'contract_not_found' ? 404 : 400).json({ error: access.error })
    if (role === 'customer' && !access.isCustomer) return res.status(403).json({ error: 'forbidden' })
    if (role === 'executor' && !access.isExecutor) return res.status(403).json({ error: 'forbidden' })

    const disputes = db.collection('disputes')
    const existing = await disputes.findOne({ contractId }, { readPreference: 'primary' })
    if (existing) return res.json(toDto(existing))

    const now = new Date()
    const docToInsert = {
      contractId,
      openedByUserId: userPublicId,
      reason,
      status: 'open',
      assignedArbiterId: null,
      slaDueAt: addMsToIso(now.toISOString(), SLA_MS),
      decision: null,
      lockedDecisionAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      // Denormalized for fast list access
      customerId: access.contract.clientId ?? null,
      executorId: access.contract.executorId ?? null,
    }
    const insertRes = await disputes.insertOne(docToInsert)
    const created = await disputes.findOne({ _id: insertRes.insertedId }, { readPreference: 'primary' })

    // Sync contract + assignment best-effort
    await db.collection('contracts').updateOne(
      { _id: access.contract._id },
      { $set: { status: 'disputed', updatedAt: now } },
    )
    const taskId = typeof access.contract.taskId === 'string' ? access.contract.taskId : null
    const executorId = typeof access.contract.executorId === 'string' ? access.contract.executorId : null
    if (taskId && executorId) {
      await db.collection('assignments').updateOne({ taskId, executorId }, { $set: { status: 'dispute_opened', updatedAt: now } })
      try {
        await db.collection('tasks').updateOne({ _id: new mongoose.Types.ObjectId(taskId) }, { $set: { status: 'dispute', updatedAt: now } })
      } catch {
        // ignore
      }
    }

    // Best-effort: notify the other party that dispute was opened.
    try {
      const contract = access.contract
      const taskId = typeof contract?.taskId === 'string' ? contract.taskId : null
      const isCustomer = role === 'customer'
      const recipientMongoId =
        isCustomer
          ? (typeof contract?.executorMongoId === 'string' && contract.executorMongoId
              ? contract.executorMongoId
              : await resolveMongoIdFromPublicId(db, contract?.executorId))
          : (typeof contract?.clientMongoId === 'string' && contract.clientMongoId
              ? contract.clientMongoId
              : await resolveMongoIdFromPublicId(db, contract?.clientId))
      if (recipientMongoId && taskId && created?._id) {
        await addNotification(db, recipientMongoId, 'Открыт спор по заданию.', {
          type: 'dispute_opened',
          taskId,
          disputeId: String(created._id),
          actorUserId: userPublicId,
          contractId: String(contract._id),
        })
      }
    } catch {
      // ignore
    }

    return res.status(201).json(toDto(created))
  }))

  // Arbiter takes dispute in work.
  router.post('/api/disputes/:disputeId/take-in-work', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    const { userPublicId } = getAuthIds(r)
    if (role !== 'arbiter') return res.status(403).json({ error: 'forbidden' })

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.disputeId))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_dispute_id' })
    const expectedVersion = typeof req.body?.expectedVersion === 'number' ? req.body.expectedVersion : null

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const disputes = db.collection('disputes')

    const d = await disputes.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!d) return res.status(404).json({ error: 'not_found' })
    if (d.lockedDecisionAt) return res.json(toDto(d))
    if (d.status === 'closed') return res.json(toDto(d))
    if (d.assignedArbiterId && d.assignedArbiterId !== userPublicId) return res.status(409).json({ error: 'assigned_to_another' })
    if (expectedVersion !== null && expectedVersion !== d.version) return res.status(409).json({ error: 'version_mismatch' })

    const now = new Date()
    const update = await disputes.findOneAndUpdate(
      { _id: oid },
      { $set: { assignedArbiterId: userPublicId, status: 'in_review', updatedAt: now }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    )
    const doc = update?.value ?? update
    return res.json(toDto(doc))
  }))

  router.post('/api/disputes/:disputeId/request-more-info', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    const { userPublicId } = getAuthIds(r)
    if (role !== 'arbiter') return res.status(403).json({ error: 'forbidden' })

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.disputeId))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_dispute_id' })
    const expectedVersion = typeof req.body?.expectedVersion === 'number' ? req.body.expectedVersion : null

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const disputes = db.collection('disputes')

    const d = await disputes.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!d) return res.status(404).json({ error: 'not_found' })
    if (d.lockedDecisionAt) return res.json(toDto(d))
    if (d.status === 'closed') return res.json(toDto(d))
    if (d.assignedArbiterId && d.assignedArbiterId !== userPublicId) return res.status(409).json({ error: 'assigned_to_another' })
    if (expectedVersion !== null && expectedVersion !== d.version) return res.status(409).json({ error: 'version_mismatch' })

    const now = new Date()
    const update = await disputes.findOneAndUpdate(
      { _id: oid },
      { $set: { assignedArbiterId: d.assignedArbiterId ?? userPublicId, status: 'need_more_info', updatedAt: now }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    )
    const doc = update?.value ?? update
    const disputeIdStr = String(oid)
    try {
      await db.collection('disputeMessages').insertOne({
        disputeId: disputeIdStr,
        authorUserId: userPublicId,
        kind: 'system',
        text: 'Арбитр запросил дополнительную информацию.',
        createdAt: now,
      })
    } catch {
      // ignore
    }
    return res.json(toDto(doc))
  }))

  router.post('/api/disputes/:disputeId/decide', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    const { userPublicId } = getAuthIds(r)
    if (role !== 'arbiter') return res.status(403).json({ error: 'forbidden' })

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.disputeId))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_dispute_id' })

    const expectedVersion = typeof req.body?.expectedVersion === 'number' ? req.body.expectedVersion : null
    const decision = normalizeDecision(req.body?.decision)
    if (!decision) return res.status(400).json({ error: 'invalid_decision' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const disputes = db.collection('disputes')
    const contracts = db.collection('contracts')

    const d = await disputes.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!d) return res.status(404).json({ error: 'not_found' })
    if (d.lockedDecisionAt) return res.json(toDto(d))
    if (d.status === 'closed') return res.json(toDto(d))
    if (d.assignedArbiterId && d.assignedArbiterId !== userPublicId) return res.status(409).json({ error: 'assigned_to_another' })
    if (expectedVersion !== null && expectedVersion !== d.version) return res.status(409).json({ error: 'version_mismatch' })
    if (d.status !== 'in_review') return res.status(409).json({ error: 'invalid_status', status: d.status })

    const now = new Date()
    const update = await disputes.findOneAndUpdate(
      { _id: oid },
      { $set: { status: 'decided', decision, lockedDecisionAt: now.toISOString(), updatedAt: now }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    )
    const doc = update?.value ?? update

    // Execute escrow movement based on decision (idempotent).
    try {
      const contractId = String(doc.contractId || '')
      const contract = await contracts.findOne({ _id: new mongoose.Types.ObjectId(contractId) }, { readPreference: 'primary' })
      if (contract) {
        const taskId = contract.taskId
        const executorId = contract.executorId
        if (decision.payout === 'executor') {
          await releaseEscrowToExecutor({ db, balanceRepo: req.app?.locals?.balanceRepo, taskId, executorId })
        } else if (decision.payout === 'customer') {
          await refundEscrowToCustomer({ db, balanceRepo: req.app?.locals?.balanceRepo, taskId, executorId })
        } else if (decision.payout === 'split' || decision.payout === 'partial') {
          const locale = inferLocale(req)
          const requestCurrency = currencyFromLocale(locale)
          const usdRubRate = requestCurrency === 'USD'
            ? await getUsdRubRate({ dataDir: req.app?.locals?.dataDir })
            : null
          const executorAmountRub =
            requestCurrency === 'USD' ? toRub(decision.executorAmount, 'USD', usdRubRate) : round2(decision.executorAmount)
          const customerAmountRub =
            requestCurrency === 'USD' ? toRub(decision.customerAmount, 'USD', usdRubRate) : round2(decision.customerAmount)
          await splitEscrow({
            db,
            balanceRepo: req.app?.locals?.balanceRepo,
            taskId,
            executorId,
            executorAmount: executorAmountRub,
            customerAmount: customerAmountRub,
          })
        }
        await contracts.updateOne({ _id: contract._id }, { $set: { status: 'resolved', updatedAt: now } })

        // Sync assignment+task best-effort
        await db.collection('assignments').updateOne(
          { taskId, executorId },
          { $set: { status: 'accepted', acceptedAt: now.toISOString(), updatedAt: now } },
        )
        try {
          await db.collection('tasks').updateOne(
            { _id: new mongoose.Types.ObjectId(String(taskId)) },
            { $set: { status: 'closed', completedAt: now, updatedAt: now } },
          )
        } catch {
          // ignore
        }
      }
    } catch {
      // If money move fails, we still keep the decision locked; ops can reconcile.
    }

    return res.json(toDto(doc))
  }))

  // Backward-compatible alias: some clients expect /api/disputes/:id/decision
  router.post('/api/disputes/:disputeId/decision', asyncHandler(async (req, res, next) => {
    // Delegate to the canonical handler by reusing its logic.
    // We can't "call" the other route directly, so we keep the implementation in sync:
    try {
      const r = await tryResolveAuthUser(req)
      if (!r.ok) return res.status(401).json({ error: r.error })
      const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
      const { userPublicId } = getAuthIds(r)
      if (role !== 'arbiter') return res.status(403).json({ error: 'forbidden' })

      let oid = null
      try {
        oid = new mongoose.Types.ObjectId(String(req.params.disputeId))
      } catch {
        oid = null
      }
      if (!oid) return res.status(400).json({ error: 'bad_dispute_id' })

      const expectedVersion = typeof req.body?.expectedVersion === 'number' ? req.body.expectedVersion : null
      const decision = normalizeDecision(req.body?.decision)
      if (!decision) return res.status(400).json({ error: 'invalid_decision' })

      const db = mongoose.connection.db
      if (!db) return res.status(500).json({ error: 'mongo_not_available' })
      const disputes = db.collection('disputes')
      const contracts = db.collection('contracts')

      const d = await disputes.findOne({ _id: oid }, { readPreference: 'primary' })
      if (!d) return res.status(404).json({ error: 'not_found' })
      if (d.lockedDecisionAt) return res.json(toDto(d))
      if (d.status === 'closed') return res.json(toDto(d))
      if (d.assignedArbiterId && d.assignedArbiterId !== userPublicId) return res.status(409).json({ error: 'assigned_to_another' })
      if (expectedVersion !== null && expectedVersion !== d.version) return res.status(409).json({ error: 'version_mismatch' })
      if (d.status !== 'in_review') return res.status(409).json({ error: 'invalid_status', status: d.status })

      const now = new Date()
      const update = await disputes.findOneAndUpdate(
        { _id: oid },
        { $set: { status: 'decided', decision, lockedDecisionAt: now.toISOString(), updatedAt: now }, $inc: { version: 1 } },
        { returnDocument: 'after' },
      )
      const doc = update?.value ?? update

      // Execute escrow movement based on decision (idempotent).
      try {
        const contractId = String(doc.contractId || '')
        const contract = await contracts.findOne({ _id: new mongoose.Types.ObjectId(contractId) }, { readPreference: 'primary' })
        if (contract) {
          const taskId = contract.taskId
          const executorId = contract.executorId
          if (decision.payout === 'executor') {
            await releaseEscrowToExecutor({ db, balanceRepo: req.app?.locals?.balanceRepo, taskId, executorId })
          } else if (decision.payout === 'customer') {
            await refundEscrowToCustomer({ db, balanceRepo: req.app?.locals?.balanceRepo, taskId, executorId })
          } else if (decision.payout === 'split' || decision.payout === 'partial') {
            const locale = inferLocale(req)
            const requestCurrency = currencyFromLocale(locale)
            const usdRubRate = requestCurrency === 'USD'
              ? await getUsdRubRate({ dataDir: req.app?.locals?.dataDir })
              : null
            const executorAmountRub =
              requestCurrency === 'USD' ? toRub(decision.executorAmount, 'USD', usdRubRate) : round2(decision.executorAmount)
            const customerAmountRub =
              requestCurrency === 'USD' ? toRub(decision.customerAmount, 'USD', usdRubRate) : round2(decision.customerAmount)
            await splitEscrow({
              db,
              balanceRepo: req.app?.locals?.balanceRepo,
              taskId,
              executorId,
              executorAmount: executorAmountRub,
              customerAmount: customerAmountRub,
            })
          }
          await contracts.updateOne({ _id: contract._id }, { $set: { status: 'resolved', updatedAt: now } })

          // Sync assignment+task best-effort
          await db.collection('assignments').updateOne(
            { taskId, executorId },
            { $set: { status: 'accepted', acceptedAt: now.toISOString(), updatedAt: now } },
          )
          try {
            await db.collection('tasks').updateOne(
              { _id: new mongoose.Types.ObjectId(String(taskId)) },
              { $set: { status: 'closed', completedAt: now, updatedAt: now } },
            )
          } catch {
            // ignore
          }
        }
      } catch {
        // If money move fails, we still keep the decision locked; ops can reconcile.
      }

      return res.json(toDto(doc))
    } catch (e) {
      next(e)
    }
  }))

  router.post('/api/disputes/:disputeId/close', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    const { userMongoId, userPublicId } = getAuthIds(r)

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.disputeId))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_dispute_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const disputes = db.collection('disputes')

    const d = await disputes.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!d) return res.status(404).json({ error: 'not_found' })

    const isArbiter = role === 'arbiter' && d.assignedArbiterId === userPublicId
    const isExecutor = role === 'executor' && (d.executorId === userPublicId || d.executorId === userMongoId)
    const isCustomer = role === 'customer' && (d.customerId === userPublicId || d.customerId === userMongoId)
    if (!isArbiter && !isExecutor && !isCustomer) return res.status(403).json({ error: 'forbidden' })

    const now = new Date()
    const update = await disputes.findOneAndUpdate(
      { _id: oid },
      { $set: { status: 'closed', updatedAt: now }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    )
    const doc = update?.value ?? update
    return res.json(toDto(doc))
  }))

  return router
}

