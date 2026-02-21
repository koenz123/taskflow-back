import express from 'express'
import mongoose from 'mongoose'
import { tryResolveAuthUser } from './authSession.js'

const START_WINDOW_MS = 12 * 60 * 60 * 1000
const EXECUTION_WINDOW_MS = 24 * 60 * 60 * 1000
const PAUSE_AUTO_ACCEPT_MS = 12 * 60 * 60 * 1000
const PAUSE_MAX_MS = 24 * 60 * 60 * 1000

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function addMs(isoOrDate, ms) {
  const base = isoOrDate instanceof Date ? isoOrDate.getTime() : Date.parse(String(isoOrDate))
  const safe = Number.isFinite(base) ? base : Date.now()
  return new Date(safe + ms).toISOString()
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

function pickContractMongoIds(contract) {
  const clientMongoId = typeof contract?.clientMongoId === 'string' && contract.clientMongoId ? contract.clientMongoId : null
  const executorMongoId = typeof contract?.executorMongoId === 'string' && contract.executorMongoId ? contract.executorMongoId : null
  return { clientMongoId, executorMongoId }
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

function normalizePauseReason(value) {
  if (value === 'illness' || value === 'family' || value === 'force_majeure') return value
  return null
}

async function recomputeTaskStatus({ db, taskId }) {
  const tasks = db.collection('tasks')
  const assignments = db.collection('assignments')

  const task = await tasks.findOne({ _id: new mongoose.Types.ObjectId(taskId) }, { readPreference: 'primary' })
  if (!task) return

  const list = await assignments.find({ taskId }).toArray()
  const statuses = new Set(list.map((a) => a.status))
  const assignedCount = Array.isArray(task.assignedExecutorIds) ? task.assignedExecutorIds.length : 0
  const maxExecutors =
    typeof task.maxExecutors === 'number' && Number.isFinite(task.maxExecutors) && task.maxExecutors > 0
      ? Math.max(1, Math.floor(task.maxExecutors))
      : 1

  let next = task.status
  if (statuses.has('dispute_opened')) next = 'dispute'
  else if (statuses.has('submitted')) next = 'review'
  else if (assignedCount > 0) next = 'in_progress'
  else if (task.publishedAt) next = 'open'

  const allDone =
    list.length > 0 &&
    list.every((a) => a.status === 'accepted' || a.status === 'cancelled_by_customer' || a.status === 'removed_auto')
  if (allDone && assignedCount >= maxExecutors) next = 'closed'

  const now = new Date()
  const set = { status: next, updatedAt: now }
  if (next === 'closed' && !task.completedAt) set.completedAt = now
  if (next !== 'closed' && task.completedAt) set.completedAt = null
  await tasks.updateOne({ _id: task._id }, { $set: set })
}

export function createAssignmentsApi() {
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  // Soft auth list: return [] if not logged in.
  router.get('/api/assignments', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.json([])
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    const { userMongoId, userPublicId } = getAuthIds(r)

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const assignments = db.collection('assignments')
    const tasks = db.collection('tasks')

    if (role === 'executor') {
      const items = await assignments
        .find({ executorId: { $in: [userPublicId, userMongoId] } })
        .sort({ assignedAt: -1 })
        .limit(500)
        .toArray()
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
      const items = await assignments.find({ taskId: { $in: taskIds } }).sort({ assignedAt: -1 }).limit(500).toArray()
      return res.json(items.map(toDto))
    }

    return res.json([])
  }))

  router.post('/api/assignments/:assignmentId/start', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'executor') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.assignmentId))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_assignment_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const assignments = db.collection('assignments')

    const a = await assignments.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!a) return res.status(404).json({ error: 'not_found' })
    if (a.executorId !== userPublicId && a.executorId !== userMongoId) return res.status(403).json({ error: 'forbidden' })

    if (a.status !== 'pending_start') return res.json(toDto(a))

    const nowIso = new Date().toISOString()
    const base = addMs(nowIso, EXECUTION_WINDOW_MS)
    const update = await assignments.findOneAndUpdate(
      { _id: oid },
      {
        $set: {
          status: 'in_progress',
          startedAt: nowIso,
          executionBaseDeadlineAt: base,
          executionExtensionMs: 0,
          executionDeadlineAt: base,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    )
    const doc = update?.value ?? update
    if (doc?.taskId) await recomputeTaskStatus({ db, taskId: doc.taskId })
    return res.json(toDto(doc))
  }))

  router.post('/api/assignments/:assignmentId/request-pause', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'executor') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.assignmentId))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_assignment_id' })

    const reasonId = normalizePauseReason(req.body?.reasonId)
    const durationMsRaw = typeof req.body?.durationMs === 'number' ? req.body.durationMs : Number(req.body?.durationMs)
    const durationMs = Number.isFinite(durationMsRaw) ? Math.floor(durationMsRaw) : NaN
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : ''
    if (!reasonId) return res.status(400).json({ error: 'invalid_reason' })
    if (!Number.isFinite(durationMs) || durationMs <= 0) return res.status(400).json({ error: 'invalid_duration' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const assignments = db.collection('assignments')
    const contracts = db.collection('contracts')
    const tasks = db.collection('tasks')

    const a = await assignments.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!a) return res.status(404).json({ error: 'not_found' })
    if (a.executorId !== userPublicId && a.executorId !== userMongoId) return res.status(403).json({ error: 'forbidden' })

    if (a.status !== 'in_progress') return res.json(toDto(a))
    if (a.pauseUsed) return res.json(toDto(a))

    const nowIso = new Date().toISOString()
    const dur = Math.max(5 * 60 * 1000, Math.min(PAUSE_MAX_MS, durationMs))
    const update = await assignments.findOneAndUpdate(
      { _id: oid },
      {
        $set: {
          status: 'pause_requested',
          pauseUsed: true,
          pauseRequestedAt: nowIso,
          pauseAutoAcceptAt: addMs(nowIso, PAUSE_AUTO_ACCEPT_MS),
          pauseReasonId: reasonId,
          pauseComment: comment || null,
          pauseRequestedDurationMs: dur,
          pauseDecision: null,
          pauseDecidedAt: null,
          pausedAt: null,
          pausedUntil: null,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    )
    const doc = update?.value ?? update

    // Notify customer about pause request (best-effort).
    try {
      const taskId = typeof a.taskId === 'string' ? a.taskId : ''
      let customerMongoId = null

      const contractId = typeof a.contractId === 'string' ? a.contractId : null
      if (contractId) {
        let cOid = null
        try {
          cOid = new mongoose.Types.ObjectId(contractId)
        } catch {
          cOid = null
        }
        if (cOid) {
          const c = await contracts.findOne({ _id: cOid }, { readPreference: 'primary' })
          const picked = pickContractMongoIds(c)
          customerMongoId = picked.clientMongoId
          if (!customerMongoId) customerMongoId = await resolveMongoIdFromPublicId(db, c?.clientId)
        }
      }

      if (!customerMongoId && taskId) {
        let tOid = null
        try {
          tOid = new mongoose.Types.ObjectId(taskId)
        } catch {
          tOid = null
        }
        if (tOid) {
          const task = await tasks.findOne({ _id: tOid }, { readPreference: 'primary' })
          customerMongoId =
            typeof task?.createdByMongoId === 'string' && task.createdByMongoId ? task.createdByMongoId : null
        }
      }

      if (customerMongoId && taskId) {
        await addNotification(db, customerMongoId, 'Исполнитель запросил паузу.', {
          type: 'task_pause_requested',
          taskId,
          actorUserId: userPublicId,
          message: comment || undefined,
        })
      }
    } catch {
      // ignore
    }

    return res.json(toDto(doc))
  }))

  // Alias: allow clients to operate by (taskId, executorId) without knowing assignmentId.
  // Useful for UI flows that already have taskId + executorId.
  router.post('/api/tasks/:taskId/assignments/:executorId/request-pause', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'executor') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    const taskId = typeof req.params?.taskId === 'string' ? req.params.taskId.trim() : ''
    const executorId = typeof req.params?.executorId === 'string' ? req.params.executorId.trim() : ''
    if (!taskId) return res.status(400).json({ error: 'missing_taskId' })
    if (!executorId) return res.status(400).json({ error: 'missing_executorId' })
    if (executorId !== userPublicId && executorId !== userMongoId) return res.status(403).json({ error: 'forbidden' })

    const reasonId = normalizePauseReason(req.body?.reasonId)
    const durationMsRaw = typeof req.body?.durationMs === 'number' ? req.body.durationMs : Number(req.body?.durationMs)
    const durationMs = Number.isFinite(durationMsRaw) ? Math.floor(durationMsRaw) : NaN
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : ''
    if (!reasonId) return res.status(400).json({ error: 'invalid_reason' })
    if (!Number.isFinite(durationMs) || durationMs <= 0) return res.status(400).json({ error: 'invalid_duration' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const assignments = db.collection('assignments')
    const contracts = db.collection('contracts')
    const tasks = db.collection('tasks')

    const a = await assignments.findOne({ taskId: String(taskId), executorId: String(executorId) }, { readPreference: 'primary' })
    if (!a) return res.status(404).json({ error: 'not_found' })
    if (a.executorId !== userPublicId && a.executorId !== userMongoId) return res.status(403).json({ error: 'forbidden' })

    if (a.status !== 'in_progress') return res.json(toDto(a))
    if (a.pauseUsed) return res.json(toDto(a))

    const nowIso = new Date().toISOString()
    const dur = Math.max(5 * 60 * 1000, Math.min(PAUSE_MAX_MS, durationMs))
    const update = await assignments.findOneAndUpdate(
      { _id: a._id },
      {
        $set: {
          status: 'pause_requested',
          pauseUsed: true,
          pauseRequestedAt: nowIso,
          pauseAutoAcceptAt: addMs(nowIso, PAUSE_AUTO_ACCEPT_MS),
          pauseReasonId: reasonId,
          pauseComment: comment || null,
          pauseRequestedDurationMs: dur,
          pauseDecision: null,
          pauseDecidedAt: null,
          pausedAt: null,
          pausedUntil: null,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    )
    const doc = update?.value ?? update

    // Notify customer about pause request (best-effort).
    try {
      let customerMongoId = null

      const contractId = typeof a.contractId === 'string' ? a.contractId : null
      if (contractId) {
        let cOid = null
        try {
          cOid = new mongoose.Types.ObjectId(contractId)
        } catch {
          cOid = null
        }
        if (cOid) {
          const c = await contracts.findOne({ _id: cOid }, { readPreference: 'primary' })
          const picked = pickContractMongoIds(c)
          customerMongoId = picked.clientMongoId
          if (!customerMongoId) customerMongoId = await resolveMongoIdFromPublicId(db, c?.clientId)
        }
      }

      if (!customerMongoId) {
        let tOid = null
        try {
          tOid = new mongoose.Types.ObjectId(taskId)
        } catch {
          tOid = null
        }
        if (tOid) {
          const task = await tasks.findOne({ _id: tOid }, { readPreference: 'primary' })
          customerMongoId =
            typeof task?.createdByMongoId === 'string' && task.createdByMongoId ? task.createdByMongoId : null
        }
      }

      if (customerMongoId) {
        await addNotification(db, customerMongoId, 'Исполнитель запросил паузу.', {
          type: 'task_pause_requested',
          taskId,
          actorUserId: userPublicId,
          message: comment || undefined,
        })
      }
    } catch {
      // ignore
    }

    return res.json(toDto(doc))
  }))

  router.post('/api/tasks/:taskId/assignments/:executorId/accept-pause', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    const taskId = typeof req.params?.taskId === 'string' ? req.params.taskId.trim() : ''
    const executorId = typeof req.params?.executorId === 'string' ? req.params.executorId.trim() : ''
    if (!taskId) return res.status(400).json({ error: 'missing_taskId' })
    if (!executorId) return res.status(400).json({ error: 'missing_executorId' })

    let tOid = null
    try {
      tOid = new mongoose.Types.ObjectId(taskId)
    } catch {
      tOid = null
    }
    if (!tOid) return res.status(400).json({ error: 'bad_task_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const assignments = db.collection('assignments')
    const tasks = db.collection('tasks')
    const contracts = db.collection('contracts')

    const task = await tasks.findOne({ _id: tOid }, { readPreference: 'primary' })
    if (!task) return res.status(404).json({ error: 'task_not_found' })
    const isOwner =
      task.createdByMongoId === userMongoId ||
      task.createdByUserId === userPublicId ||
      task.userId === userMongoId ||
      task.userId === userPublicId
    if (!isOwner) return res.status(403).json({ error: 'forbidden' })

    const a = await assignments.findOne({ taskId: String(taskId), executorId: String(executorId) }, { readPreference: 'primary' })
    if (!a) return res.status(404).json({ error: 'not_found' })

    if (a.status !== 'pause_requested') return res.json(toDto(a))
    if (!a.pauseRequestedAt || !a.pauseRequestedDurationMs || !a.executionBaseDeadlineAt) return res.json(toDto(a))

    const decidedAt = new Date().toISOString()
    const pausedAt = decidedAt
    const pausedUntil = addMs(pausedAt, a.pauseRequestedDurationMs)

    const prevExt = typeof a.executionExtensionMs === 'number' && Number.isFinite(a.executionExtensionMs) ? a.executionExtensionMs : 0
    const maxExtendMs = Math.min(PAUSE_MAX_MS, Math.floor(EXECUTION_WINDOW_MS * 0.5))
    const remaining = Math.max(0, maxExtendMs - prevExt)
    const waitMs = Math.max(0, Date.parse(decidedAt) - Date.parse(a.pauseRequestedAt))
    const add = Math.min(remaining, waitMs + a.pauseRequestedDurationMs)
    const nextExt = prevExt + add
    const nextDeadline = addMs(a.executionBaseDeadlineAt, nextExt)

    const update = await assignments.findOneAndUpdate(
      { _id: a._id },
      {
        $set: {
          status: 'paused',
          pauseDecision: 'accepted',
          pauseDecidedAt: decidedAt,
          pausedAt,
          pausedUntil,
          executionExtensionMs: nextExt,
          executionDeadlineAt: nextDeadline,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    )
    const doc = update?.value ?? update

    // Best-effort: notify executor that pause was accepted.
    try {
      const contractId = typeof a.contractId === 'string' ? a.contractId : null
      let executorMongoId = typeof a.executorMongoId === 'string' && a.executorMongoId ? a.executorMongoId : null
      if (!executorMongoId && contractId) {
        let cOid = null
        try {
          cOid = new mongoose.Types.ObjectId(contractId)
        } catch {
          cOid = null
        }
        if (cOid) {
          const c = await contracts.findOne({ _id: cOid }, { readPreference: 'primary' })
          const picked = pickContractMongoIds(c)
          executorMongoId = picked.executorMongoId
          if (!executorMongoId) executorMongoId = await resolveMongoIdFromPublicId(db, c?.executorId)
        }
      }
      if (executorMongoId) {
        await addNotification(db, executorMongoId, 'Заказчик принял паузу.', {
          type: 'task_pause_accepted',
          taskId,
          actorUserId: userPublicId,
          message: typeof a.pauseComment === 'string' && a.pauseComment.trim() ? a.pauseComment.trim() : undefined,
        })
      }
    } catch {
      // ignore
    }

    return res.json(toDto(doc))
  }))

  router.post('/api/tasks/:taskId/assignments/:executorId/reject-pause', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    const taskId = typeof req.params?.taskId === 'string' ? req.params.taskId.trim() : ''
    const executorId = typeof req.params?.executorId === 'string' ? req.params.executorId.trim() : ''
    if (!taskId) return res.status(400).json({ error: 'missing_taskId' })
    if (!executorId) return res.status(400).json({ error: 'missing_executorId' })

    let tOid = null
    try {
      tOid = new mongoose.Types.ObjectId(taskId)
    } catch {
      tOid = null
    }
    if (!tOid) return res.status(400).json({ error: 'bad_task_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const assignments = db.collection('assignments')
    const tasks = db.collection('tasks')
    const contracts = db.collection('contracts')

    const task = await tasks.findOne({ _id: tOid }, { readPreference: 'primary' })
    if (!task) return res.status(404).json({ error: 'task_not_found' })
    const isOwner =
      task.createdByMongoId === userMongoId ||
      task.createdByUserId === userPublicId ||
      task.userId === userMongoId ||
      task.userId === userPublicId
    if (!isOwner) return res.status(403).json({ error: 'forbidden' })

    const a = await assignments.findOne({ taskId: String(taskId), executorId: String(executorId) }, { readPreference: 'primary' })
    if (!a) return res.status(404).json({ error: 'not_found' })

    if (a.status !== 'pause_requested') return res.json(toDto(a))
    const decidedAt = new Date().toISOString()
    const update = await assignments.findOneAndUpdate(
      { _id: a._id },
      { $set: { status: 'in_progress', pauseDecision: 'rejected', pauseDecidedAt: decidedAt, updatedAt: new Date() } },
      { returnDocument: 'after' },
    )
    const doc = update?.value ?? update

    // Best-effort: notify executor that pause was rejected.
    try {
      const note = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
      const contractId = typeof a.contractId === 'string' ? a.contractId : null
      let executorMongoId = typeof a.executorMongoId === 'string' && a.executorMongoId ? a.executorMongoId : null
      if (!executorMongoId && contractId) {
        let cOid = null
        try {
          cOid = new mongoose.Types.ObjectId(contractId)
        } catch {
          cOid = null
        }
        if (cOid) {
          const c = await contracts.findOne({ _id: cOid }, { readPreference: 'primary' })
          const picked = pickContractMongoIds(c)
          executorMongoId = picked.executorMongoId
          if (!executorMongoId) executorMongoId = await resolveMongoIdFromPublicId(db, c?.executorId)
        }
      }
      if (executorMongoId) {
        await addNotification(db, executorMongoId, 'Заказчик отклонил паузу.', {
          type: 'task_pause_rejected',
          taskId,
          actorUserId: userPublicId,
          message: note || undefined,
        })
      }
    } catch {
      // ignore
    }

    return res.json(toDto(doc))
  }))

  router.post('/api/assignments/:assignmentId/accept-pause', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.assignmentId))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_assignment_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const assignments = db.collection('assignments')
    const tasks = db.collection('tasks')
    const contracts = db.collection('contracts')

    const a = await assignments.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!a) return res.status(404).json({ error: 'not_found' })
    const taskId = typeof a.taskId === 'string' ? a.taskId : ''
    if (!taskId) return res.status(500).json({ error: 'bad_assignment' })
    const task = await tasks.findOne({ _id: new mongoose.Types.ObjectId(taskId) }, { readPreference: 'primary' })
    if (!task) return res.status(404).json({ error: 'task_not_found' })

    const isOwner =
      task.createdByMongoId === userMongoId ||
      task.createdByUserId === userPublicId ||
      task.userId === userMongoId ||
      task.userId === userPublicId
    if (!isOwner) return res.status(403).json({ error: 'forbidden' })

    if (a.status !== 'pause_requested') return res.json(toDto(a))
    if (!a.pauseRequestedAt || !a.pauseRequestedDurationMs || !a.executionBaseDeadlineAt) return res.json(toDto(a))

    const decidedAt = new Date().toISOString()
    const pausedAt = decidedAt
    const pausedUntil = addMs(pausedAt, a.pauseRequestedDurationMs)

    const prevExt = typeof a.executionExtensionMs === 'number' && Number.isFinite(a.executionExtensionMs) ? a.executionExtensionMs : 0
    const maxExtendMs = Math.min(PAUSE_MAX_MS, Math.floor(EXECUTION_WINDOW_MS * 0.5))
    const remaining = Math.max(0, maxExtendMs - prevExt)
    const waitMs = Math.max(0, Date.parse(decidedAt) - Date.parse(a.pauseRequestedAt))
    const add = Math.min(remaining, waitMs + a.pauseRequestedDurationMs)
    const nextExt = prevExt + add
    const nextDeadline = addMs(a.executionBaseDeadlineAt, nextExt)

    const update = await assignments.findOneAndUpdate(
      { _id: oid },
      {
        $set: {
          status: 'paused',
          pauseDecision: 'accepted',
          pauseDecidedAt: decidedAt,
          pausedAt,
          pausedUntil,
          executionExtensionMs: nextExt,
          executionDeadlineAt: nextDeadline,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    )
    const doc = update?.value ?? update
    // Best-effort: notify executor that pause was accepted.
    try {
      const contractId = typeof a.contractId === 'string' ? a.contractId : null
      let executorMongoId = typeof a.executorMongoId === 'string' && a.executorMongoId ? a.executorMongoId : null
      if (!executorMongoId && contractId) {
        let cOid = null
        try {
          cOid = new mongoose.Types.ObjectId(contractId)
        } catch {
          cOid = null
        }
        if (cOid) {
          const c = await contracts.findOne({ _id: cOid }, { readPreference: 'primary' })
          const picked = pickContractMongoIds(c)
          executorMongoId = picked.executorMongoId
          if (!executorMongoId) executorMongoId = await resolveMongoIdFromPublicId(db, c?.executorId)
        }
      }
      if (executorMongoId && taskId) {
        await addNotification(db, executorMongoId, 'Заказчик принял паузу.', {
          type: 'task_pause_accepted',
          taskId,
          actorUserId: userPublicId,
          message: typeof a.pauseComment === 'string' && a.pauseComment.trim() ? a.pauseComment.trim() : undefined,
        })
      }
    } catch {
      // ignore
    }
    return res.json(toDto(doc))
  }))

  router.post('/api/assignments/:assignmentId/reject-pause', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.assignmentId))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_assignment_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const assignments = db.collection('assignments')
    const tasks = db.collection('tasks')
    const contracts = db.collection('contracts')

    const a = await assignments.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!a) return res.status(404).json({ error: 'not_found' })
    const taskId = typeof a.taskId === 'string' ? a.taskId : ''
    if (!taskId) return res.status(500).json({ error: 'bad_assignment' })
    const task = await tasks.findOne({ _id: new mongoose.Types.ObjectId(taskId) }, { readPreference: 'primary' })
    if (!task) return res.status(404).json({ error: 'task_not_found' })

    const isOwner =
      task.createdByMongoId === userMongoId ||
      task.createdByUserId === userPublicId ||
      task.userId === userMongoId ||
      task.userId === userPublicId
    if (!isOwner) return res.status(403).json({ error: 'forbidden' })

    if (a.status !== 'pause_requested') return res.json(toDto(a))
    const decidedAt = new Date().toISOString()
    const update = await assignments.findOneAndUpdate(
      { _id: oid },
      { $set: { status: 'in_progress', pauseDecision: 'rejected', pauseDecidedAt: decidedAt, updatedAt: new Date() } },
      { returnDocument: 'after' },
    )
    const doc = update?.value ?? update
    // Best-effort: notify executor that pause was rejected.
    try {
      const note = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
      const contractId = typeof a.contractId === 'string' ? a.contractId : null
      let executorMongoId = typeof a.executorMongoId === 'string' && a.executorMongoId ? a.executorMongoId : null
      if (!executorMongoId && contractId) {
        let cOid = null
        try {
          cOid = new mongoose.Types.ObjectId(contractId)
        } catch {
          cOid = null
        }
        if (cOid) {
          const c = await contracts.findOne({ _id: cOid }, { readPreference: 'primary' })
          const picked = pickContractMongoIds(c)
          executorMongoId = picked.executorMongoId
          if (!executorMongoId) executorMongoId = await resolveMongoIdFromPublicId(db, c?.executorId)
        }
      }
      if (executorMongoId && taskId) {
        await addNotification(db, executorMongoId, 'Заказчик отклонил паузу.', {
          type: 'task_pause_rejected',
          taskId,
          actorUserId: userPublicId,
          message: note || undefined,
        })
      }
    } catch {
      // ignore
    }
    return res.json(toDto(doc))
  }))

  router.post('/api/assignments/:assignmentId/submit', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'executor') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.assignmentId))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_assignment_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const assignments = db.collection('assignments')
    const contracts = db.collection('contracts')

    const a = await assignments.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!a) return res.status(404).json({ error: 'not_found' })
    if (a.executorId !== userPublicId && a.executorId !== userMongoId) return res.status(403).json({ error: 'forbidden' })
    if (a.status !== 'in_progress' && a.status !== 'overdue') return res.json(toDto(a))

    const submittedAt = new Date().toISOString()
    const update = await assignments.findOneAndUpdate(
      { _id: oid },
      { $set: { status: 'submitted', submittedAt, updatedAt: new Date() } },
      { returnDocument: 'after' },
    )
    const doc = update?.value ?? update

    // Best-effort: sync contract status if linked.
    const contractId = typeof doc?.contractId === 'string' ? doc.contractId : null
    if (contractId) {
      try {
        await contracts.updateOne(
          { _id: new mongoose.Types.ObjectId(contractId) },
          { $set: { status: 'submitted', updatedAt: new Date() } },
        )
      } catch {
        // ignore
      }
    }

    if (doc?.taskId) await recomputeTaskStatus({ db, taskId: doc.taskId })
    return res.json(toDto(doc))
  }))

  router.post('/api/assignments/:assignmentId/accept', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.assignmentId))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_assignment_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const assignments = db.collection('assignments')
    const tasks = db.collection('tasks')
    const contracts = db.collection('contracts')

    const a = await assignments.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!a) return res.status(404).json({ error: 'not_found' })
    const taskId = typeof a.taskId === 'string' ? a.taskId : ''
    if (!taskId) return res.status(500).json({ error: 'bad_assignment' })
    const task = await tasks.findOne({ _id: new mongoose.Types.ObjectId(taskId) }, { readPreference: 'primary' })
    if (!task) return res.status(404).json({ error: 'task_not_found' })

    const isOwner =
      task.createdByMongoId === userMongoId ||
      task.createdByUserId === userPublicId ||
      task.userId === userMongoId ||
      task.userId === userPublicId
    if (!isOwner) return res.status(403).json({ error: 'forbidden' })

    if (a.status !== 'submitted' && a.status !== 'dispute_opened') return res.json(toDto(a))

    const acceptedAt = new Date().toISOString()
    const update = await assignments.findOneAndUpdate(
      { _id: oid },
      { $set: { status: 'accepted', acceptedAt, updatedAt: new Date() } },
      { returnDocument: 'after' },
    )
    const doc = update?.value ?? update

    // Best-effort: sync contract status if linked.
    const contractId = typeof doc?.contractId === 'string' ? doc.contractId : null
    if (contractId) {
      try {
        await contracts.updateOne(
          { _id: new mongoose.Types.ObjectId(contractId) },
          { $set: { status: 'approved', updatedAt: new Date() } },
        )
      } catch {
        // ignore
      }
    }

    if (doc?.taskId) await recomputeTaskStatus({ db, taskId: doc.taskId })
    return res.json(toDto(doc))
  }))

  return router
}

