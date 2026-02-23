import express from 'express'
import mongoose from 'mongoose'
import { tryResolveAuthUser } from '../auth/authSession.js'
import { freezeEscrow } from '../services/escrowService.js'
import { canExecutorRespond } from '../services/executorSanctionsService.js'
import { createNotification } from '../services/notificationService.js'

const START_WINDOW_MS = 12 * 60 * 60 * 1000

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}

function addMs(date, ms) {
  return new Date(date.getTime() + ms).toISOString()
}

function getAuthIds(r) {
  const userMongoId = String(r.userId)
  const telegramUserId =
    typeof r.user?.telegramUserId === 'string' && r.user.telegramUserId ? r.user.telegramUserId : null
  const userPublicId = telegramUserId ? `tg_${telegramUserId}` : userMongoId
  return { userMongoId, userPublicId, telegramUserId }
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

let ensureIndexesPromise = null
async function ensureIndexes(db) {
  if (ensureIndexesPromise) return ensureIndexesPromise
  ensureIndexesPromise = (async () => {
    const applications = db.collection('applications')
    const assignments = db.collection('assignments')
    const contracts = db.collection('contracts')

    await applications.createIndex({ taskId: 1, executorUserId: 1 }, { unique: true })
    await applications.createIndex({ taskId: 1, status: 1, createdAt: -1 })
    await applications.createIndex({ executorUserId: 1, createdAt: -1 })

    await assignments.createIndex({ taskId: 1, executorId: 1 }, { unique: true })
    await contracts.createIndex({ taskId: 1, executorId: 1 }, { unique: true })
  })().catch((e) => {
    ensureIndexesPromise = null
    console.warn('[applicationsApi] ensureIndexes failed', e instanceof Error ? e.message : String(e))
  })
  return ensureIndexesPromise
}

export function createApplicationsApi() {
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  // Soft auth list: return [] if not logged in.
  router.get('/api/applications', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.json([])
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    const { userMongoId, userPublicId } = getAuthIds(r)

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    await ensureIndexes(db)

    const applications = db.collection('applications')
    const tasks = db.collection('tasks')

    const taskId = typeof req.query?.taskId === 'string' ? req.query.taskId.trim() : ''
    if (taskId) {
      // Filter by one task if the requester has access to it.
      const task = await tasks.findOne({ _id: new mongoose.Types.ObjectId(taskId) }, { readPreference: 'primary' })
      if (!task) return res.json([])

      const isOwner =
        task.createdByMongoId === userMongoId ||
        task.createdByUserId === userPublicId ||
        task.userId === userMongoId ||
        task.userId === userPublicId

      const isExecutor =
        role === 'executor' &&
        (Array.isArray(task.assignedExecutorIds)
          ? task.assignedExecutorIds.includes(userPublicId) || task.assignedExecutorIds.includes(userMongoId)
          : false)

      if (role === 'customer' && isOwner) {
        const items = await applications.find({ taskId }).sort({ createdAt: -1 }).limit(500).toArray()
        return res.json(items.map(toDto))
      }
      if (role === 'executor') {
        const items = await applications
          .find({ taskId, executorUserId: userPublicId })
          .sort({ createdAt: -1 })
          .limit(500)
          .toArray()
        return res.json(items.map(toDto))
      }
      if (isExecutor) {
        const items = await applications
          .find({ taskId, executorUserId: userPublicId })
          .sort({ createdAt: -1 })
          .limit(500)
          .toArray()
        return res.json(items.map(toDto))
      }
      return res.json([])
    }

    if (role === 'executor') {
      const items = await applications.find({ executorUserId: userPublicId }).sort({ createdAt: -1 }).limit(500).toArray()
      return res.json(items.map(toDto))
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
      const items = await applications.find({ taskId: { $in: taskIds } }).sort({ createdAt: -1 }).limit(500).toArray()
      return res.json(items.map(toDto))
    }

    return res.json([])
  }))

  // Executor applies to a task.
  router.post('/api/applications', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'executor') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId.trim() : ''
    if (!taskId) return res.status(400).json({ error: 'missing_taskId' })

    let taskOid = null
    try {
      taskOid = new mongoose.Types.ObjectId(taskId)
    } catch {
      taskOid = null
    }
    if (!taskOid) return res.status(400).json({ error: 'bad_task_id' })

    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    await ensureIndexes(db)

    // Enforce server-side sanctions: banned/blocked executors can't apply.
    const respondGuard = await canExecutorRespond(db, userPublicId, Date.now())
    if (!respondGuard.ok) {
      return res.status(403).json({
        error: respondGuard.reason === 'banned' ? 'executor_banned' : 'respond_blocked',
        reason: respondGuard.reason,
        until: respondGuard.until,
      })
    }

    const tasks = db.collection('tasks')
    const applications = db.collection('applications')

    const task = await tasks.findOne({ _id: taskOid }, { readPreference: 'primary' })
    if (!task) return res.status(404).json({ error: 'task_not_found' })
    if (!task.publishedAt) return res.status(409).json({ error: 'task_not_published' })
    const status = typeof task.status === 'string' ? task.status : 'draft'
    if (!['open', 'in_progress', 'review', 'dispute'].includes(status)) {
      return res.status(409).json({ error: 'task_not_open', status })
    }
    if (task.executorMode === 'ai') return res.status(409).json({ error: 'task_not_available' })

    const assigned = Array.isArray(task.assignedExecutorIds) ? task.assignedExecutorIds : []
    if (assigned.includes(userPublicId) || assigned.includes(userMongoId)) {
      return res.status(409).json({ error: 'already_assigned' })
    }
    const maxExecutors =
      typeof task.maxExecutors === 'number' && Number.isFinite(task.maxExecutors) && task.maxExecutors > 0
        ? Math.max(1, Math.floor(task.maxExecutors))
        : 1
    if (assigned.length >= maxExecutors) return res.status(409).json({ error: 'no_slots' })

    const now = new Date()
    try {
      const insertRes = await applications.insertOne({
        taskId: String(task._id),
        executorUserId: userPublicId,
        executorMongoId: userMongoId,
        message: message || undefined,
        status: 'pending',
        contractId: null,
        createdAt: now,
        updatedAt: now,
      })
      // Best-effort notification to the task owner (customer).
      const ownerMongoId =
        typeof task.createdByMongoId === 'string' && task.createdByMongoId
          ? task.createdByMongoId
          : typeof task.userId === 'string' && task.userId
            ? task.userId
            : null
      if (ownerMongoId) {
        await addNotification(db, ownerMongoId, 'Новый отклик на задание.', {
          type: 'task_application_created',
          taskId: String(task._id),
          actorUserId: userPublicId,
          applicationId: String(insertRes.insertedId),
        })
      }
      const doc = await applications.findOne({ _id: insertRes.insertedId }, { readPreference: 'primary' })
      return res.status(201).json(toDto(doc))
    } catch (e) {
      // Idempotent: if already applied, return the existing record.
      const isDup = e && typeof e === 'object' && 'code' in e && e.code === 11000
      if (!isDup) throw e
      const existing = await applications.findOne(
        { taskId: String(task._id), executorUserId: userPublicId },
        { readPreference: 'primary' },
      )
      if (existing) return res.json(toDto(existing))
      return res.status(409).json({ error: 'already_applied' })
    }
  }))

  // Customer selects an application (creates contract+assignment and assigns executor to the task).
  router.post('/api/applications/:applicationId/select', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    let appOid = null
    try {
      appOid = new mongoose.Types.ObjectId(String(req.params.applicationId))
    } catch {
      appOid = null
    }
    if (!appOid) return res.status(400).json({ error: 'bad_application_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    await ensureIndexes(db)

    const applications = db.collection('applications')
    const tasks = db.collection('tasks')
    const contracts = db.collection('contracts')
    const assignments = db.collection('assignments')

    const app = await applications.findOne({ _id: appOid }, { readPreference: 'primary' })
    if (!app) return res.status(404).json({ error: 'not_found' })
    const taskId = typeof app.taskId === 'string' ? app.taskId : ''
    if (!taskId) return res.status(500).json({ error: 'bad_application' })

    const task = await tasks.findOne({ _id: new mongoose.Types.ObjectId(taskId) }, { readPreference: 'primary' })
    if (!task) return res.status(404).json({ error: 'task_not_found' })

    const isOwner =
      task.createdByMongoId === userMongoId ||
      task.createdByUserId === userPublicId ||
      task.userId === userMongoId ||
      task.userId === userPublicId
    if (!isOwner) return res.status(403).json({ error: 'forbidden' })

    const executorId = typeof app.executorUserId === 'string' ? app.executorUserId : ''
    const executorMongoId = typeof app.executorMongoId === 'string' ? app.executorMongoId : null
    if (!executorId) return res.status(500).json({ error: 'bad_application' })

    // Prevent assigning a banned executor (blocked is temporary; allow assignment).
    const execGuard = await canExecutorRespond(db, executorId, Date.now())
    if (!execGuard.ok && execGuard.reason === 'banned') {
      return res.status(409).json({ error: 'executor_banned' })
    }

    const assigned = Array.isArray(task.assignedExecutorIds) ? task.assignedExecutorIds : []
    const maxExecutors =
      typeof task.maxExecutors === 'number' && Number.isFinite(task.maxExecutors) && task.maxExecutors > 0
        ? Math.max(1, Math.floor(task.maxExecutors))
        : 1
    if (!assigned.includes(executorId) && assigned.length >= maxExecutors) return res.status(409).json({ error: 'no_slots' })

    const now = new Date()

    // 0) Freeze escrow (if needed) BEFORE selecting/assigning.
    const amount =
      typeof task.budgetAmount === 'number' && Number.isFinite(task.budgetAmount) && task.budgetAmount >= 0
        ? task.budgetAmount
        : 0
    const fr = await freezeEscrow({
      db,
      balanceRepo: req.app?.locals?.balanceRepo,
      taskId: String(task._id),
      contractId: null,
      customerId: userPublicId,
      customerMongoId: userMongoId,
      executorId,
      executorMongoId: executorMongoId,
      amount,
    })
    if (!fr.ok) {
      if (fr.error === 'insufficient_balance') return res.status(409).json({ error: 'insufficient_balance', required: fr.required, balance: fr.balance })
      return res.status(500).json({ error: 'escrow_freeze_failed' })
    }

    // 1) Upsert contract
    const contractUpsert = await contracts.findOneAndUpdate(
      { taskId, executorId },
      {
        $setOnInsert: {
          taskId,
          clientId: userPublicId,
          clientMongoId: userMongoId,
          executorId,
          executorMongoId: executorMongoId,
          escrowAmount:
            typeof task.budgetAmount === 'number' && Number.isFinite(task.budgetAmount) && task.budgetAmount >= 0
              ? task.budgetAmount
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
    const contractDoc = contractUpsert?.value ?? contractUpsert
    const contractId = contractDoc?._id ? String(contractDoc._id) : null
    if (contractId) {
      // Attach contractId to escrow if it was created without it.
      await db.collection('escrows').updateOne({ taskId, executorId }, { $set: { contractId, updatedAt: now } })
    }

    // 2) Upsert assignment
    const assignedAt = now.toISOString()
    const startDeadlineAt = addMs(now, START_WINDOW_MS)
    await assignments.updateOne(
      { taskId, executorId },
      {
        $setOnInsert: {
          taskId,
          executorId,
          executorMongoId: executorMongoId,
          assignedAt,
          startDeadlineAt,
          status: 'pending_start',
          createdAt: now,
        },
        $set: { updatedAt: now, contractId },
      },
      { upsert: true },
    )

    // 3) Assign executor to task (idempotent)
    await tasks.updateOne(
      { _id: task._id },
      { $addToSet: { assignedExecutorIds: executorId }, $set: { status: 'in_progress', takenAt: task.takenAt ?? now, updatedAt: now } },
    )

    // 4) Mark application as selected + link contract
    await applications.updateOne(
      { _id: appOid },
      { $set: { status: 'selected', contractId: contractId, updatedAt: now } },
    )

    // Best-effort notifications (server-side).
    await addNotification(
      db,
      executorMongoId,
      'Вас назначили исполнителем по заданию. Нажмите «Начать работу» в карточке задания.',
      { type: 'assignment_selected', taskId, actorUserId: userPublicId, contractId, applicationId: String(appOid) },
    )

    const fresh = await applications.findOne({ _id: appOid }, { readPreference: 'primary' })
    return res.json(toDto(fresh))
  }))

  // Backward-compatible: some clients use PUT /api/applications/:id with { status }.
  // Supported statuses:
  // - selected: same as /select
  // - rejected: same as /reject
  router.put('/api/applications/:applicationId', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    const status = typeof req.body?.status === 'string' ? req.body.status.trim() : ''
    if (status !== 'selected' && status !== 'rejected') return res.status(400).json({ error: 'invalid_status' })

    if (status === 'selected') {
      // Delegate to the same logic as /select by reusing the existing route semantics.
      // (Implementation duplicated for compatibility; keep behavior consistent.)
      let appOid = null
      try {
        appOid = new mongoose.Types.ObjectId(String(req.params.applicationId))
      } catch {
        appOid = null
      }
      if (!appOid) return res.status(400).json({ error: 'bad_application_id' })

      const db = mongoose.connection.db
      if (!db) return res.status(500).json({ error: 'mongo_not_available' })
      await ensureIndexes(db)

      const applications = db.collection('applications')
      const tasks = db.collection('tasks')
      const contracts = db.collection('contracts')
      const assignments = db.collection('assignments')

      const app = await applications.findOne({ _id: appOid }, { readPreference: 'primary' })
      if (!app) return res.status(404).json({ error: 'not_found' })
      const taskId = typeof app.taskId === 'string' ? app.taskId : ''
      if (!taskId) return res.status(500).json({ error: 'bad_application' })

      const task = await tasks.findOne({ _id: new mongoose.Types.ObjectId(taskId) }, { readPreference: 'primary' })
      if (!task) return res.status(404).json({ error: 'task_not_found' })

      const isOwner =
        task.createdByMongoId === userMongoId ||
        task.createdByUserId === userPublicId ||
        task.userId === userMongoId ||
        task.userId === userPublicId
      if (!isOwner) return res.status(403).json({ error: 'forbidden' })

      const executorId = typeof app.executorUserId === 'string' ? app.executorUserId : ''
      const executorMongoId = typeof app.executorMongoId === 'string' ? app.executorMongoId : null
      if (!executorId) return res.status(500).json({ error: 'bad_application' })

      const execGuard = await canExecutorRespond(db, executorId, Date.now())
      if (!execGuard.ok && execGuard.reason === 'banned') {
        return res.status(409).json({ error: 'executor_banned' })
      }

      const assigned = Array.isArray(task.assignedExecutorIds) ? task.assignedExecutorIds : []
      const maxExecutors =
        typeof task.maxExecutors === 'number' && Number.isFinite(task.maxExecutors) && task.maxExecutors > 0
          ? Math.max(1, Math.floor(task.maxExecutors))
          : 1
      if (!assigned.includes(executorId) && assigned.length >= maxExecutors) return res.status(409).json({ error: 'no_slots' })

      const now = new Date()
      const amount =
        typeof task.budgetAmount === 'number' && Number.isFinite(task.budgetAmount) && task.budgetAmount >= 0
          ? task.budgetAmount
          : 0
      const fr = await freezeEscrow({
        db,
        balanceRepo: req.app?.locals?.balanceRepo,
        taskId: String(task._id),
        contractId: null,
        customerId: userPublicId,
        customerMongoId: userMongoId,
        executorId,
        executorMongoId: executorMongoId,
        amount,
      })
      if (!fr.ok) {
        if (fr.error === 'insufficient_balance') return res.status(409).json({ error: 'insufficient_balance', required: fr.required, balance: fr.balance })
        return res.status(500).json({ error: 'escrow_freeze_failed' })
      }

      const contractUpsert = await contracts.findOneAndUpdate(
        { taskId, executorId },
        {
          $setOnInsert: {
            taskId,
            clientId: userPublicId,
            clientMongoId: userMongoId,
            executorId,
            executorMongoId: executorMongoId,
            escrowAmount:
              typeof task.budgetAmount === 'number' && Number.isFinite(task.budgetAmount) && task.budgetAmount >= 0
                ? task.budgetAmount
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
      const contractDoc = contractUpsert?.value ?? contractUpsert
      const contractId = contractDoc?._id ? String(contractDoc._id) : null
      if (contractId) {
        await db.collection('escrows').updateOne({ taskId, executorId }, { $set: { contractId, updatedAt: now } })
      }

      const assignedAt = now.toISOString()
      const startDeadlineAt = addMs(now, START_WINDOW_MS)
      await assignments.updateOne(
        { taskId, executorId },
        {
          $setOnInsert: {
            taskId,
            executorId,
            executorMongoId: executorMongoId,
            assignedAt,
            startDeadlineAt,
            status: 'pending_start',
            createdAt: now,
          },
          $set: { updatedAt: now, contractId },
        },
        { upsert: true },
      )

      await tasks.updateOne(
        { _id: task._id },
        { $addToSet: { assignedExecutorIds: executorId }, $set: { status: 'in_progress', takenAt: task.takenAt ?? now, updatedAt: now } },
      )

      await applications.updateOne(
        { _id: appOid },
        { $set: { status: 'selected', contractId: contractId, updatedAt: now } },
      )

      await addNotification(
        db,
        executorMongoId,
        'Вас назначили исполнителем по заданию. Нажмите «Начать работу» в карточке задания.',
        { type: 'assignment_selected', taskId, actorUserId: userPublicId, contractId, applicationId: String(appOid) },
      )

      const fresh = await applications.findOne({ _id: appOid }, { readPreference: 'primary' })
      return res.json(toDto(fresh))
    }

    // status === 'rejected' (same semantics as /reject)
    let appOid = null
    try {
      appOid = new mongoose.Types.ObjectId(String(req.params.applicationId))
    } catch {
      appOid = null
    }
    if (!appOid) return res.status(400).json({ error: 'bad_application_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    await ensureIndexes(db)

    const applications = db.collection('applications')
    const tasks = db.collection('tasks')

    const app = await applications.findOne({ _id: appOid }, { readPreference: 'primary' })
    if (!app) return res.status(404).json({ error: 'not_found' })

    const taskId = typeof app.taskId === 'string' ? app.taskId : ''
    if (!taskId) return res.status(500).json({ error: 'bad_application' })

    const task = await tasks.findOne({ _id: new mongoose.Types.ObjectId(taskId) }, { readPreference: 'primary' })
    if (!task) return res.status(404).json({ error: 'task_not_found' })

    const isOwner =
      task.createdByMongoId === userMongoId ||
      task.createdByUserId === userPublicId ||
      task.userId === userMongoId ||
      task.userId === userPublicId
    if (!isOwner) return res.status(403).json({ error: 'forbidden' })

    const current = typeof app.status === 'string' ? app.status : 'pending'
    if (current === 'rejected') return res.json(toDto(app))
    if (current === 'selected') return res.status(409).json({ error: 'already_selected' })

    const now = new Date()
    await applications.updateOne({ _id: appOid }, { $set: { status: 'rejected', updatedAt: now } })
    const fresh = await applications.findOne({ _id: appOid }, { readPreference: 'primary' })
    return res.json(toDto(fresh))
  }))

  // Backward-compatible: some clients POST /api/applications/:id (without /select or /reject).
  // If body.status is provided, we honor it; otherwise return the current application as-is.
  router.post('/api/applications/:applicationId', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })

    const { userMongoId, userPublicId } = getAuthIds(r)

    const status = typeof req.body?.status === 'string' ? req.body.status.trim() : ''
    if (status && status !== 'selected' && status !== 'rejected') return res.status(400).json({ error: 'invalid_status' })

    let appOid = null
    try {
      appOid = new mongoose.Types.ObjectId(String(req.params.applicationId))
    } catch {
      appOid = null
    }
    if (!appOid) return res.status(400).json({ error: 'bad_application_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    await ensureIndexes(db)

    const applications = db.collection('applications')
    const tasks = db.collection('tasks')
    const contracts = db.collection('contracts')
    const assignments = db.collection('assignments')

    const app = await applications.findOne({ _id: appOid }, { readPreference: 'primary' })
    if (!app) return res.status(404).json({ error: 'not_found' })

    const taskId = typeof app.taskId === 'string' ? app.taskId : ''
    if (!taskId) return res.status(500).json({ error: 'bad_application' })

    const task = await tasks.findOne({ _id: new mongoose.Types.ObjectId(taskId) }, { readPreference: 'primary' })
    if (!task) return res.status(404).json({ error: 'task_not_found' })

    const isOwner =
      task.createdByMongoId === userMongoId ||
      task.createdByUserId === userPublicId ||
      task.userId === userMongoId ||
      task.userId === userPublicId
    if (!isOwner) return res.status(403).json({ error: 'forbidden' })

    // POST without explicit status means "select" for legacy clients.
    const effective = status || 'selected'

    if (effective === 'rejected') {
      const current = typeof app.status === 'string' ? app.status : 'pending'
      if (current === 'rejected') return res.json(toDto(app))
      if (current === 'selected') return res.status(409).json({ error: 'already_selected' })
      const now = new Date()
      await applications.updateOne({ _id: appOid }, { $set: { status: 'rejected', updatedAt: now } })
      const fresh = await applications.findOne({ _id: appOid }, { readPreference: 'primary' })
      return res.json(toDto(fresh))
    }

    // --- effective === 'selected' ---
    const executorId = typeof app.executorUserId === 'string' ? app.executorUserId : ''
    const executorMongoId = typeof app.executorMongoId === 'string' ? app.executorMongoId : null
    if (!executorId) return res.status(500).json({ error: 'bad_application' })

    const execGuard = await canExecutorRespond(db, executorId, Date.now())
    if (!execGuard.ok && execGuard.reason === 'banned') {
      return res.status(409).json({ error: 'executor_banned' })
    }

    const assigned = Array.isArray(task.assignedExecutorIds) ? task.assignedExecutorIds : []
    const maxExecutors =
      typeof task.maxExecutors === 'number' && Number.isFinite(task.maxExecutors) && task.maxExecutors > 0
        ? Math.max(1, Math.floor(task.maxExecutors))
        : 1
    if (!assigned.includes(executorId) && assigned.length >= maxExecutors) return res.status(409).json({ error: 'no_slots' })

    const now = new Date()
    const amount =
      typeof task.budgetAmount === 'number' && Number.isFinite(task.budgetAmount) && task.budgetAmount >= 0
        ? task.budgetAmount
        : 0
    const fr = await freezeEscrow({
      db,
      balanceRepo: req.app?.locals?.balanceRepo,
      taskId: String(task._id),
      contractId: null,
      customerId: userPublicId,
      customerMongoId: userMongoId,
      executorId,
      executorMongoId: executorMongoId,
      amount,
    })
    if (!fr.ok) {
      if (fr.error === 'insufficient_balance') return res.status(409).json({ error: 'insufficient_balance', required: fr.required, balance: fr.balance })
      return res.status(500).json({ error: 'escrow_freeze_failed' })
    }

    const contractUpsert = await contracts.findOneAndUpdate(
      { taskId, executorId },
      {
        $setOnInsert: {
          taskId,
          clientId: userPublicId,
          clientMongoId: userMongoId,
          executorId,
          executorMongoId: executorMongoId,
          escrowAmount:
            typeof task.budgetAmount === 'number' && Number.isFinite(task.budgetAmount) && task.budgetAmount >= 0
              ? task.budgetAmount
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
    const contractDoc = contractUpsert?.value ?? contractUpsert
    const contractId = contractDoc?._id ? String(contractDoc._id) : null
    if (contractId) {
      await db.collection('escrows').updateOne({ taskId, executorId }, { $set: { contractId, updatedAt: now } })
    }

    const assignedAt = now.toISOString()
    const startDeadlineAt = addMs(now, START_WINDOW_MS)
    await assignments.updateOne(
      { taskId, executorId },
      {
        $setOnInsert: {
          taskId,
          executorId,
          executorMongoId: executorMongoId,
          assignedAt,
          startDeadlineAt,
          status: 'pending_start',
          createdAt: now,
        },
        $set: { updatedAt: now, contractId },
      },
      { upsert: true },
    )

    await tasks.updateOne(
      { _id: task._id },
      { $addToSet: { assignedExecutorIds: executorId }, $set: { status: 'in_progress', takenAt: task.takenAt ?? now, updatedAt: now } },
    )

    await applications.updateOne(
      { _id: appOid },
      { $set: { status: 'selected', contractId: contractId, updatedAt: now } },
    )

    await addNotification(
      db,
      executorMongoId,
      'Вас назначили исполнителем по заданию. Нажмите «Начать работу» в карточке задания.',
      { type: 'assignment_selected', taskId, actorUserId: userPublicId, contractId, applicationId: String(appOid) },
    )

    const fresh = await applications.findOne({ _id: appOid }, { readPreference: 'primary' })
    return res.json(toDto(fresh))

  }))

  // Customer rejects an application (marks it as rejected).
  router.post('/api/applications/:applicationId/reject', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    let appOid = null
    try {
      appOid = new mongoose.Types.ObjectId(String(req.params.applicationId))
    } catch {
      appOid = null
    }
    if (!appOid) return res.status(400).json({ error: 'bad_application_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    await ensureIndexes(db)

    const applications = db.collection('applications')
    const tasks = db.collection('tasks')

    const app = await applications.findOne({ _id: appOid }, { readPreference: 'primary' })
    if (!app) return res.status(404).json({ error: 'not_found' })

    const taskId = typeof app.taskId === 'string' ? app.taskId : ''
    if (!taskId) return res.status(500).json({ error: 'bad_application' })

    const task = await tasks.findOne({ _id: new mongoose.Types.ObjectId(taskId) }, { readPreference: 'primary' })
    if (!task) return res.status(404).json({ error: 'task_not_found' })

    const isOwner =
      task.createdByMongoId === userMongoId ||
      task.createdByUserId === userPublicId ||
      task.userId === userMongoId ||
      task.userId === userPublicId
    if (!isOwner) return res.status(403).json({ error: 'forbidden' })

    const current = typeof app.status === 'string' ? app.status : 'pending'
    if (current === 'rejected') return res.json(toDto(app))
    // Do not allow rejecting an already selected application (use "switch executor" flow instead).
    if (current === 'selected') return res.status(409).json({ error: 'already_selected' })

    const now = new Date()
    await applications.updateOne({ _id: appOid }, { $set: { status: 'rejected', updatedAt: now } })
    const fresh = await applications.findOne({ _id: appOid }, { readPreference: 'primary' })
    return res.json(toDto(fresh))
  }))

  // Patch endpoint used by some clients to reject applications.
  // Only allows { status: 'rejected' } for now.
  router.patch('/api/applications/:applicationId', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    let appOid = null
    try {
      appOid = new mongoose.Types.ObjectId(String(req.params.applicationId))
    } catch {
      appOid = null
    }
    if (!appOid) return res.status(400).json({ error: 'bad_application_id' })

    const status = typeof req.body?.status === 'string' ? req.body.status.trim() : ''
    if (status !== 'rejected') return res.status(400).json({ error: 'invalid_status' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    await ensureIndexes(db)

    const applications = db.collection('applications')
    const tasks = db.collection('tasks')

    const app = await applications.findOne({ _id: appOid }, { readPreference: 'primary' })
    if (!app) return res.status(404).json({ error: 'not_found' })

    const taskId = typeof app.taskId === 'string' ? app.taskId : ''
    if (!taskId) return res.status(500).json({ error: 'bad_application' })

    const task = await tasks.findOne({ _id: new mongoose.Types.ObjectId(taskId) }, { readPreference: 'primary' })
    if (!task) return res.status(404).json({ error: 'task_not_found' })

    const isOwner =
      task.createdByMongoId === userMongoId ||
      task.createdByUserId === userPublicId ||
      task.userId === userMongoId ||
      task.userId === userPublicId
    if (!isOwner) return res.status(403).json({ error: 'forbidden' })

    const current = typeof app.status === 'string' ? app.status : 'pending'
    if (current === 'rejected') return res.json(toDto(app))
    if (current === 'selected') return res.status(409).json({ error: 'already_selected' })

    const now = new Date()
    await applications.updateOne({ _id: appOid }, { $set: { status: 'rejected', updatedAt: now } })
    const fresh = await applications.findOne({ _id: appOid }, { readPreference: 'primary' })
    return res.json(toDto(fresh))
  }))

  return router
}

