import express from 'express'
import mongoose from 'mongoose'

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}

function normalizeIdsParam(value) {
  const raw = typeof value === 'string' ? value : ''
  if (!raw.trim()) return []
  const parts = raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  // preserve order, uniq
  const seen = new Set()
  const out = []
  for (const p of parts) {
    const key = p.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out.slice(0, 200)
}

function toPublicId(userDoc) {
  const tgId =
    typeof userDoc?.telegramUserId === 'string' && userDoc.telegramUserId ? userDoc.telegramUserId : null
  return tgId ? `tg_${tgId}` : String(userDoc?._id)
}

function toPublicUser(userDoc) {
  if (!userDoc) return null
  const telegramUserId =
    typeof userDoc.telegramUserId === 'string' && userDoc.telegramUserId ? userDoc.telegramUserId : null
  const id = telegramUserId ? `tg_${telegramUserId}` : String(userDoc._id)
  const fullName =
    (typeof userDoc.fullName === 'string' && userDoc.fullName.trim()) ||
    [userDoc.firstName, userDoc.lastName].filter(Boolean).join(' ').trim() ||
    userDoc.username ||
    id

  const socials = userDoc.socials && typeof userDoc.socials === 'object' && !Array.isArray(userDoc.socials) ? userDoc.socials : {}

  return {
    id,
    role: typeof userDoc.role === 'string' && userDoc.role ? userDoc.role : 'pending',
    fullName,
    email: typeof userDoc.email === 'string' && userDoc.email.trim() ? userDoc.email : undefined,
    phone: typeof userDoc.phone === 'string' && userDoc.phone.trim() ? userDoc.phone : undefined,
    company: typeof userDoc.company === 'string' && userDoc.company.trim() ? userDoc.company : undefined,
    avatarDataUrl:
      typeof userDoc.avatarDataUrl === 'string' && userDoc.avatarDataUrl.trim() ? userDoc.avatarDataUrl : undefined,
    socials,
    telegramUserId,
  }
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

export function createUsersApi() {
  const router = express.Router()

  router.get('/api/users/:userId', asyncHandler(async (req, res) => {
    const parsed = parseUserId(req.params.userId)
    if (!parsed) return res.status(400).json({ error: 'bad_user_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const users = db.collection('users')

    const query = parsed.kind === 'tg' ? { telegramUserId: parsed.telegramUserId } : { _id: parsed._id }
    const userDoc = await users.findOne(query, { readPreference: 'primary' })
    if (!userDoc) return res.status(404).json({ error: 'not_found' })
    return res.json(toPublicUser(userDoc))
  }))

  // Optional batch: GET /api/users?ids=a,b,c
  router.get('/api/users', asyncHandler(async (req, res) => {
    const ids = normalizeIdsParam(req.query?.ids)
    if (!ids.length) return res.json([])

    const parsed = ids.map(parseUserId).filter(Boolean)
    if (!parsed.length) return res.json([])

    const mongoIds = parsed.filter((x) => x.kind === 'mongo').map((x) => x._id)
    const tgIds = parsed.filter((x) => x.kind === 'tg').map((x) => x.telegramUserId)

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const users = db.collection('users')

    const query = { $or: [{ _id: { $in: mongoIds } }, { telegramUserId: { $in: tgIds } }] }
    const docs = await users.find(query, { readPreference: 'primary' }).limit(500).toArray()

    const byId = new Map()
    for (const d of docs) byId.set(toPublicId(d), toPublicUser(d))

    // Return in requested order, omitting missing.
    const out = []
    for (const id of ids) {
      const u = byId.get(id)
      if (u) out.push(u)
    }
    return res.json(out)
  }))

  return router
}

