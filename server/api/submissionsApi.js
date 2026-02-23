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

function getAuthIds(r) {
  const userMongoId = String(r.userId)
  const telegramUserId =
    typeof r.user?.telegramUserId === 'string' && r.user.telegramUserId ? r.user.telegramUserId : null
  const userPublicId = telegramUserId ? `tg_${telegramUserId}` : userMongoId
  return { userMongoId, userPublicId }
}

function normalizeFiles(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((x) => {
      if (!isObject(x)) return null
      const kindRaw = typeof x.kind === 'string' ? x.kind.trim() : ''
      const kind = kindRaw || 'upload'
      const url =
        typeof x.url === 'string'
          ? x.url.trim()
          : typeof x.path === 'string'
            ? x.path.trim()
            : typeof x.fileUrl === 'string'
              ? x.fileUrl.trim()
              : typeof x.mediaUrl === 'string'
                ? x.mediaUrl.trim()
                : ''
      if (!url) return null
      const title = typeof x.title === 'string' && x.title.trim() ? x.title.trim() : undefined
      const mediaType =
        x.mediaType === 'video' || x.mediaType === 'image' || x.mediaType === 'file' ? x.mediaType : undefined
      if (kind === 'external_url') return { kind: 'external_url', url, title, mediaType }
      if (kind === 'upload') {
        const workId = typeof x.workId === 'string' && x.workId.trim() ? x.workId.trim() : undefined
        return { kind: 'upload', url, title, mediaType, workId }
      }
      return null
    })
    .filter(Boolean)
}

function pickCompletionVideoUrl(files) {
  if (!Array.isArray(files) || files.length === 0) return undefined
  const firstVideo = files.find((f) => f && typeof f === 'object' && f.mediaType === 'video' && typeof f.url === 'string' && f.url.trim())
  if (firstVideo) return firstVideo.url.trim()
  const firstAny = files.find((f) => f && typeof f === 'object' && typeof f.url === 'string' && f.url.trim())
  return firstAny ? firstAny.url.trim() : undefined
}

function toDto(doc) {
  if (!doc) return null
  const { _id, createdAt, ...rest } = doc
  return {
    id: String(_id),
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    completionVideoUrl: pickCompletionVideoUrl(doc.files),
    ...rest,
  }
}

async function canAccessContract({ db, contractId, userPublicId, userMongoId }) {
  const contracts = db.collection('contracts')
  let oid = null
  try {
    oid = new mongoose.Types.ObjectId(String(contractId))
  } catch {
    oid = null
  }
  if (!oid) return { ok: false, error: 'bad_contract_id' }
  const contract = await contracts.findOne({ _id: oid }, { readPreference: 'primary' })
  if (!contract) return { ok: false, error: 'contract_not_found' }

  const isExecutor = contract.executorId === userPublicId || contract.executorId === userMongoId
  const isCustomer = contract.clientId === userPublicId || contract.clientId === userMongoId
  if (!isExecutor && !isCustomer) return { ok: false, error: 'forbidden' }
  return { ok: true, contract, isExecutor, isCustomer }
}

export function createSubmissionsApi() {
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  router.get('/api/submissions', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.json([])
    const { userMongoId, userPublicId } = getAuthIds(r)

    const contractId = typeof req.query?.contractId === 'string' ? req.query.contractId.trim() : ''
    if (!contractId) return res.json([])

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const access = await canAccessContract({ db, contractId, userPublicId, userMongoId })
    if (!access.ok) return res.status(access.error === 'forbidden' ? 403 : 400).json({ error: access.error })

    const submissions = db.collection('submissions')
    const items = await submissions
      .find({ contractId: String(contractId) })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray()
    return res.json(items.map(toDto))
  }))

  // Executor submits work. Supersedes previous submissions for the same contract.
  router.post('/api/submissions', asyncHandler(async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
    if (role !== 'executor') return res.status(403).json({ error: 'forbidden' })
    const { userMongoId, userPublicId } = getAuthIds(r)

    const contractId = typeof req.body?.contractId === 'string' ? req.body.contractId.trim() : ''
    if (!contractId) return res.status(400).json({ error: 'missing_contractId' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const access = await canAccessContract({ db, contractId, userPublicId, userMongoId })
    if (!access.ok) return res.status(access.error === 'forbidden' ? 403 : 400).json({ error: access.error })
    if (!access.isExecutor) return res.status(403).json({ error: 'forbidden' })

    const message = typeof req.body?.message === 'string' && req.body.message.trim() ? req.body.message.trim() : null
    const files = normalizeFiles(req.body?.files)
    if (!message && files.length === 0) return res.status(400).json({ error: 'empty_submission' })

    const submissions = db.collection('submissions')
    const contracts = db.collection('contracts')
    const assignments = db.collection('assignments')
    const tasks = db.collection('tasks')

    const now = new Date()

    const hadPrevious = Boolean(
      await submissions.findOne({ contractId, status: 'submitted' }, { projection: { _id: 1 }, readPreference: 'primary' }),
    )

    // Supersede previous submissions
    await submissions.updateMany({ contractId, status: { $ne: 'superseded' } }, { $set: { status: 'superseded' } })

    const insertRes = await submissions.insertOne({
      contractId,
      message: message ?? undefined,
      files,
      status: 'submitted',
      createdAt: now,
    })

    const submissionId = String(insertRes.insertedId)

    // Sync contract fields
    await contracts.updateOne(
      { _id: access.contract._id },
      {
        $set: {
          status: 'submitted',
          lastSubmissionId: submissionId,
          updatedAt: now,
        },
      },
    )

    // Sync assignment status (best-effort)
    const taskId = typeof access.contract.taskId === 'string' ? access.contract.taskId : null
    const executorId = typeof access.contract.executorId === 'string' ? access.contract.executorId : null
    if (taskId && executorId) {
      await assignments.updateOne(
        { taskId, executorId },
        { $set: { status: 'submitted', submittedAt: now.toISOString(), updatedAt: now } },
      )
      // Sync task status to review
      try {
        await tasks.updateOne({ _id: new mongoose.Types.ObjectId(taskId) }, { $set: { status: 'review', updatedAt: now } })
      } catch {
        // ignore
      }
    }

    // Best-effort: notify customer about submission/resubmission.
    try {
      const contract = access.contract
      const customerMongoId =
        typeof contract?.clientMongoId === 'string' && contract.clientMongoId
          ? contract.clientMongoId
          : await resolveMongoIdFromPublicId(db, contract?.clientId)
      const taskIdForMeta = typeof contract?.taskId === 'string' ? contract.taskId : null
      if (customerMongoId && taskIdForMeta) {
        await addNotification(db, customerMongoId, 'Исполнитель отправил работу на проверку.', {
          type: hadPrevious ? 'task_resubmitted' : 'task_submitted',
          taskId: taskIdForMeta,
          actorUserId: userPublicId,
          submissionId,
          message: message ?? undefined,
        })
      }
    } catch {
      // ignore
    }

    const doc = await submissions.findOne({ _id: insertRes.insertedId }, { readPreference: 'primary' })
    return res.status(201).json(toDto(doc))
  }))

  return router
}

