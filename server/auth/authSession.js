import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import { connectMongo } from '../infra/db.js'

function getBearerToken(req) {
  const h = req.headers?.authorization
  if (typeof h !== 'string') return ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : ''
}

function getCookie(req, name) {
  const raw = req.headers?.cookie
  if (typeof raw !== 'string' || !raw) return ''
  const parts = raw.split(';')
  for (const p of parts) {
    const [k, ...rest] = p.trim().split('=')
    if (k === name) return rest.join('=') || ''
  }
  return ''
}

async function findUserByMongoId(sub) {
  const conn = await connectMongo()
  if (!conn?.enabled || mongoose.connection.readyState !== 1) {
    return { ok: false, error: 'mongo_not_available' }
  }
  const db = mongoose.connection.db
  if (!db) return { ok: false, error: 'mongo_not_available' }
  const users = db.collection('users')

  let oid = null
  try {
    oid = new mongoose.Types.ObjectId(String(sub))
  } catch {
    oid = null
  }
  if (!oid) return { ok: false, error: 'bad_sub' }

  // Force primary reads to avoid replica lag right after signup/login.
  const user = await users.findOne({ _id: oid }, { readPreference: 'primary' })
  if (!user) return { ok: false, error: 'user_deleted' }
  return { ok: true, user }
}

async function findUserByTelegramId(tgId) {
  const conn = await connectMongo()
  if (!conn?.enabled || mongoose.connection.readyState !== 1) {
    return { ok: false, error: 'mongo_not_available' }
  }
  const db = mongoose.connection.db
  if (!db) return { ok: false, error: 'mongo_not_available' }
  const users = db.collection('users')

  // Force primary reads to avoid replica lag right after signup/login.
  const user = await users.findOne({ telegramUserId: String(tgId) }, { readPreference: 'primary' })
  if (!user) return { ok: false, error: 'user_deleted' }
  return { ok: true, user }
}

// Tries to resolve authenticated user from:
// - Authorization: Bearer <jwt>
// - Cookie tf_token=<jwt>
// - X-User-Id: tg_<telegramUserId> OR <mongoObjectId>
// Returns: { ok, user, userId, error }
export async function tryResolveAuthUser(req) {
  const JWT_SECRET = process.env.JWT_SECRET || ''

  const token = getBearerToken(req) || getCookie(req, 'tf_token')
  if (token && JWT_SECRET) {
    try {
      const payload = jwt.verify(token, JWT_SECRET)
      const sub = typeof payload?.sub === 'string' ? payload.sub : ''
      if (!sub) return { ok: false, error: 'unauthorized' }
      const r = await findUserByMongoId(sub)
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, user: r.user, userId: String(r.user._id) }
    } catch {
      // ignore token parse errors; fall through to x-user-id
    }
  }

  const header = req.headers['x-user-id']
  const rawUserId = typeof header === 'string' ? header.trim() : ''
  if (rawUserId) {
    const m = rawUserId.match(/^tg_(\d+)$/)
    if (m) {
      const r = await findUserByTelegramId(m[1])
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, user: r.user, userId: String(r.user._id) }
    }
    const r = await findUserByMongoId(rawUserId)
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, user: r.user, userId: String(r.user._id) }
  }

  return { ok: false, error: 'unauthorized' }
}

