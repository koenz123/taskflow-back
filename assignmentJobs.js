import mongoose from 'mongoose'
import { refundEscrowToCustomer } from './escrowService.js'
import { applySanctionsForViolation } from './executorSanctionsService.js'

function safeIso(v) {
  const s = typeof v === 'string' ? v.trim() : ''
  return s || null
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
    shouldClose
      ? 'closed'
      : hasDispute
        ? 'dispute'
        : hasReview
          ? 'review'
          : hasActive || assignedCount > 0
            ? 'in_progress'
            : 'open'

  const now = new Date()
  const set = { status: next, updatedAt: now }
  if (next === 'closed' && !task.completedAt) set.completedAt = now
  if (next !== 'closed' && task.completedAt) set.completedAt = null
  await tasks.updateOne({ _id: task._id }, { $set: set })

  // Best-effort: sync assignment statuses from contract statuses.
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
    } else if (c.status === 'cancelled' && a.status !== 'cancelled_by_customer' && a.status !== 'removed_auto') {
      // Keep assignment in a terminal-ish state; UI already understands removed_auto/cancelled_by_customer.
      await assignments.updateOne({ _id: a._id }, { $set: { status: 'cancelled_by_customer', updatedAt: now } })
    }
  }
}

async function notify(db, userMongoId, text, meta = null) {
  if (!userMongoId || !text) return null
  try {
    const col = db.collection('notifications')
    await col.insertOne({ userId: String(userMongoId), text: String(text), meta: meta && typeof meta === 'object' ? meta : null, createdAt: new Date() })
    return true
  } catch {
    return null
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
  // If it's a Mongo ObjectId string, use it.
  try {
    const oid = new mongoose.Types.ObjectId(raw)
    return String(oid)
  } catch {
    return null
  }
}

async function handleNoStartExpired({ db, balanceRepo, assignment, now }) {
  const assignments = db.collection('assignments')
  const tasks = db.collection('tasks')
  const contracts = db.collection('contracts')
  const applications = db.collection('applications')

  const taskId = safeIso(assignment.taskId)
  const executorId = safeIso(assignment.executorId)
  if (!taskId || !executorId) return

  // Transition first (idempotent).
  const updateRes = await assignments.updateOne(
    { _id: assignment._id, status: 'pending_start' },
    { $set: { status: 'removed_auto', updatedAt: now } },
  )
  if (!updateRes?.modifiedCount) return

  const { violationId, sanction } = await applySanctionsForViolation(db, {
    executorId,
    taskId,
    assignmentId: String(assignment._id),
    type: 'no_start_12h',
    createdAt: now.toISOString(),
  })

  // Remove executor from task.
  try {
    await tasks.updateOne(
      { _id: new mongoose.Types.ObjectId(taskId) },
      { $pull: { assignedExecutorIds: executorId }, $set: { updatedAt: now } },
    )
  } catch {
    // ignore
  }

  // Cancel contract if exists.
  await contracts.updateOne({ taskId, executorId }, { $set: { status: 'cancelled', updatedAt: now } }).catch(() => {})

  // Refund escrow (idempotent).
  await refundEscrowToCustomer({ db, balanceRepo, taskId, executorId }).catch(() => {})

  // Mark the selected application as rejected (best-effort).
  await applications
    .updateOne({ taskId, executorUserId: executorId, status: 'selected' }, { $set: { status: 'rejected', updatedAt: now } })
    .catch(() => {})

  // Recompute task status (best-effort).
  await recomputeTaskStatus({ db, taskId }).catch(() => {})

  // Best-effort notifications (store in Mongo by mongo user id).
  const execMongoId = await resolveMongoIdFromPublicId(db, executorId)
  const task = await tasks.findOne({ _id: new mongoose.Types.ObjectId(taskId) }, { projection: { createdByMongoId: 1, createdByUserId: 1 }, readPreference: 'primary' }).catch(() => null)
  const customerPublicId = task?.createdByUserId ?? null
  const customerMongoId =
    (typeof task?.createdByMongoId === 'string' && task.createdByMongoId) || (customerPublicId ? await resolveMongoIdFromPublicId(db, customerPublicId) : null)

  if (execMongoId) {
    const text = `Нарушение: не начал работу в течение 12 часов (назначение снято). Санкция: ${sanction.kind}.`
    await notify(db, execMongoId, text, {
      type: 'executor_no_start_12h',
      taskId,
      actorUserId: executorId,
      violationId,
      violationType: 'no_start_12h',
      sanction,
    })
  }
  if (customerMongoId) {
    const text = `Исполнитель не начал работу за 12 часов — назначение снято автоматически.`
    await notify(db, customerMongoId, text, {
      type: 'executor_no_start_12h',
      taskId,
      actorUserId: executorId,
      violationId,
    })
  }
}

async function handleOverdue({ db, assignment, now }) {
  const assignments = db.collection('assignments')
  const tasks = db.collection('tasks')
  const taskId = safeIso(assignment.taskId)
  const executorId = safeIso(assignment.executorId)
  if (!taskId || !executorId) return

  const updateRes = await assignments.updateOne(
    { _id: assignment._id, status: 'in_progress' },
    { $set: { status: 'overdue', overdueAt: now.toISOString(), updatedAt: now } },
  )
  if (!updateRes?.modifiedCount) return

  const { violationId, sanction } = await applySanctionsForViolation(db, {
    executorId,
    taskId,
    assignmentId: String(assignment._id),
    type: 'no_submit_24h',
    createdAt: now.toISOString(),
  })

  const execMongoId = await resolveMongoIdFromPublicId(db, executorId)
  if (execMongoId) {
    const text = `Нарушение: не сдал работу в срок (24 часа). Санкция: ${sanction.kind}.`
    await notify(db, execMongoId, text, {
      type: 'executor_overdue',
      taskId,
      actorUserId: executorId,
      violationId,
      violationType: 'no_submit_24h',
      sanction,
    })
  }

  // Notify customer (best-effort).
  try {
    const task = await tasks
      .findOne(
        { _id: new mongoose.Types.ObjectId(taskId) },
        { projection: { createdByMongoId: 1, createdByUserId: 1 }, readPreference: 'primary' },
      )
      .catch(() => null)
    const customerPublicId = task?.createdByUserId ?? null
    const customerMongoId =
      (typeof task?.createdByMongoId === 'string' && task.createdByMongoId) ||
      (customerPublicId ? await resolveMongoIdFromPublicId(db, customerPublicId) : null)
    if (customerMongoId) {
      const text = `Исполнитель просрочил выполнение задания.`
      await notify(db, customerMongoId, text, {
        type: 'executor_overdue',
        taskId,
        actorUserId: executorId,
        violationId,
      })
    }
  } catch {
    // ignore
  }
}

export async function runAssignmentJobs({ db, balanceRepo, nowMs = Date.now(), limits = { noStartBatch: 200, overdueBatch: 200 } } = {}) {
  if (!db) return { ok: false, error: 'mongo_not_available' }

  const now = new Date(nowMs)
  const nowIso = now.toISOString()
  const assignments = db.collection('assignments')

  // 1) Auto-remove if executor didn't start within 12 hours after assignment.
  const expiredPendingStart = await assignments
    .find({ status: 'pending_start', startDeadlineAt: { $lte: nowIso } }, { readPreference: 'primary' })
    .sort({ startDeadlineAt: 1 })
    .limit(Math.max(1, Math.min(1000, limits.noStartBatch ?? 200)))
    .toArray()

  for (const a of expiredPendingStart) {
    try {
      await handleNoStartExpired({ db, balanceRepo, assignment: a, now })
    } catch {
      // ignore individual failures
    }
  }

  // 2) Mark overdue when execution deadline passes and nothing submitted (best-effort).
  const overdueCandidates = await assignments
    .find({ status: 'in_progress', executionDeadlineAt: { $lte: nowIso } }, { readPreference: 'primary' })
    .sort({ executionDeadlineAt: 1 })
    .limit(Math.max(1, Math.min(1000, limits.overdueBatch ?? 200)))
    .toArray()

  for (const a of overdueCandidates) {
    try {
      await handleOverdue({ db, assignment: a, now })
    } catch {
      // ignore
    }
  }

  return { ok: true, processed: { expiredPendingStart: expiredPendingStart.length, overdue: overdueCandidates.length } }
}

