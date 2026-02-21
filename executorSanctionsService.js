import mongoose from 'mongoose'

const DECAY_DAYS = 90
const DECAY_MS = DECAY_DAYS * 24 * 60 * 60 * 1000

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString()
}

function addMs(iso, msToAdd) {
  const base = Date.parse(String(iso))
  const safeBase = Number.isFinite(base) ? base : Date.now()
  return new Date(safeBase + msToAdd).toISOString()
}

function applyDecay(level, deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return level
  const steps = Math.floor(deltaMs / DECAY_MS)
  if (!Number.isFinite(steps) || steps <= 0) return level
  return Math.max(0, level - steps)
}

function parsePublicUserId(publicId) {
  const raw = String(publicId || '').trim()
  if (!raw) return null
  const m = raw.match(/^tg_(\d+)$/)
  if (m) return { kind: 'tg', telegramUserId: m[1] }
  try {
    return { kind: 'mongo', _id: new mongoose.Types.ObjectId(raw) }
  } catch {
    return { kind: 'other', raw }
  }
}

export async function ensureSanctionsIndexes(db) {
  const violations = db.collection('executorViolations')
  const restrictions = db.collection('executorRestrictions')
  const ratingAdjustments = db.collection('ratingAdjustments')

  await Promise.allSettled([
    violations.createIndex({ assignmentId: 1, type: 1 }, { unique: true }),
    violations.createIndex({ executorId: 1, type: 1, createdAt: 1 }),
    restrictions.createIndex({ executorId: 1 }, { unique: true }),
    restrictions.createIndex({ accountStatus: 1, respondBlockedUntil: 1 }),
    ratingAdjustments.createIndex({ executorId: 1, createdAt: -1 }),
    ratingAdjustments.createIndex({ violationId: 1 }, { unique: true, sparse: true }),
  ])
}

export async function resolveMongoUserIdForPublicId(db, publicId) {
  const parsed = parsePublicUserId(publicId)
  if (!parsed) return null
  if (parsed.kind === 'mongo') return String(parsed._id)
  if (parsed.kind === 'tg') {
    const user = await db.collection('users').findOne({ telegramUserId: parsed.telegramUserId }, { projection: { _id: 1 } })
    return user?._id ? String(user._id) : null
  }
  return null
}

export async function getExecutorRestriction(db, executorId) {
  const restrictions = db.collection('executorRestrictions')
  const doc = await restrictions.findOne({ executorId: String(executorId) }, { readPreference: 'primary' })
  if (!doc) return { executorId: String(executorId), accountStatus: 'active', respondBlockedUntil: null, updatedAt: nowIso() }
  return {
    executorId: String(doc.executorId),
    accountStatus: doc.accountStatus === 'banned' ? 'banned' : 'active',
    respondBlockedUntil: typeof doc.respondBlockedUntil === 'string' && doc.respondBlockedUntil.trim() ? doc.respondBlockedUntil : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : nowIso(),
  }
}

export async function canExecutorRespond(db, executorId, nowMs = Date.now()) {
  const r = await getExecutorRestriction(db, executorId)
  if (r.accountStatus === 'banned') return { ok: false, reason: 'banned', until: null }
  if (r.respondBlockedUntil) {
    const untilMs = Date.parse(r.respondBlockedUntil)
    if (Number.isFinite(untilMs) && nowMs < untilMs) return { ok: false, reason: 'blocked', until: r.respondBlockedUntil }
  }
  return { ok: true, reason: null, until: null }
}

export async function recordViolation(db, input) {
  const violations = db.collection('executorViolations')
  const doc = {
    executorId: String(input.executorId),
    type: input.type === 'no_submit_24h' ? 'no_submit_24h' : 'no_start_12h',
    taskId: String(input.taskId),
    assignmentId: String(input.assignmentId),
    createdAt: input.createdAt ? new Date(input.createdAt) : new Date(),
  }

  try {
    const insertRes = await violations.insertOne(doc)
    return { ok: true, violation: { ...doc, _id: insertRes.insertedId } }
  } catch (e) {
    const isDup = e && typeof e === 'object' && 'code' in e && e.code === 11000
    if (!isDup) throw e
    const existing = await violations.findOne({ assignmentId: doc.assignmentId, type: doc.type }, { readPreference: 'primary' })
    return { ok: true, violation: existing ?? doc, already: true }
  }
}

export async function violationLevelForExecutor(db, executorId, type, nowMs = Date.now()) {
  const violations = db.collection('executorViolations')
  const list = await violations
    .find({ executorId: String(executorId), type: type === 'no_submit_24h' ? 'no_submit_24h' : 'no_start_12h' }, { readPreference: 'primary' })
    .sort({ createdAt: 1 })
    .limit(5000)
    .toArray()

  let level = 0
  let lastTs = null
  for (const v of list) {
    const ts =
      v?.createdAt instanceof Date ? v.createdAt.getTime() : typeof v?.createdAt === 'string' ? Date.parse(v.createdAt) : NaN
    if (!Number.isFinite(ts)) continue
    if (Number.isFinite(nowMs) && ts > nowMs) break
    if (lastTs != null) level = applyDecay(level, ts - lastTs)
    level += 1
    lastTs = ts
  }
  if (lastTs != null) level = applyDecay(level, nowMs - lastTs)
  return level
}

export async function setRespondBlockedUntil(db, executorId, untilIso, nowMs = Date.now()) {
  const restrictions = db.collection('executorRestrictions')
  const existing = await restrictions.findOne({ executorId: String(executorId) }, { readPreference: 'primary' })
  const prevUntil = typeof existing?.respondBlockedUntil === 'string' ? existing.respondBlockedUntil : null
  const prevMs = prevUntil ? Date.parse(prevUntil) : NaN
  const nextMs = Date.parse(String(untilIso))
  const finalUntil =
    Number.isFinite(prevMs) && Number.isFinite(nextMs) ? new Date(Math.max(prevMs, nextMs)).toISOString() : String(untilIso)

  await restrictions.updateOne(
    { executorId: String(executorId) },
    {
      $set: {
        executorId: String(executorId),
        accountStatus: existing?.accountStatus === 'banned' ? 'banned' : 'active',
        respondBlockedUntil: finalUntil,
        updatedAt: new Date(nowMs),
      },
      $setOnInsert: { createdAt: new Date(nowMs) },
    },
    { upsert: true },
  )
  return finalUntil
}

export async function banExecutor(db, executorId, nowMs = Date.now()) {
  const restrictions = db.collection('executorRestrictions')
  await restrictions.updateOne(
    { executorId: String(executorId) },
    {
      $set: {
        executorId: String(executorId),
        accountStatus: 'banned',
        updatedAt: new Date(nowMs),
      },
      $setOnInsert: { createdAt: new Date(nowMs) },
    },
    { upsert: true },
  )
}

export async function applySanctionsForViolation(db, input) {
  await ensureSanctionsIndexes(db)

  const vr = await recordViolation(db, input)
  const violationId = vr?.violation?._id ? String(vr.violation._id) : null
  const executorId = String(input.executorId)
  const type = input.type === 'no_submit_24h' ? 'no_submit_24h' : 'no_start_12h'
  const nowMs = input.createdAt ? Date.parse(input.createdAt) : Date.now()
  const n = await violationLevelForExecutor(db, executorId, type, Number.isFinite(nowMs) ? nowMs : Date.now())

  if (n <= 1) {
    return { violationId, sanction: { kind: 'warning', n: 1 } }
  }

  if (n === 2) {
    // Rating system is optional on backend today; we still persist the adjustment for audit/analytics.
    try {
      await db.collection('ratingAdjustments').insertOne({
        violationId,
        executorId,
        reason: type,
        deltaPercent: -5,
        createdAt: new Date(),
      })
    } catch {
      // ignore duplicates/errors (idempotent best-effort)
    }
    return { violationId, sanction: { kind: 'rating_penalty', n: 2, deltaPercent: -5 } }
  }

  if (n === 3) {
    const until = addMs(nowIso(), 24 * 60 * 60 * 1000)
    const finalUntil = await setRespondBlockedUntil(db, executorId, until)
    return { violationId, sanction: { kind: 'respond_block', n: 3, until: finalUntil, durationHours: 24 } }
  }

  if (n === 4) {
    const until = addMs(nowIso(), 72 * 60 * 60 * 1000)
    const finalUntil = await setRespondBlockedUntil(db, executorId, until)
    return { violationId, sanction: { kind: 'respond_block', n: 4, until: finalUntil, durationHours: 72 } }
  }

  await banExecutor(db, executorId)
  return { violationId, sanction: { kind: 'ban', n } }
}

