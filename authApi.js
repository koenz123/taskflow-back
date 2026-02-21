import path from 'node:path'
import crypto from 'node:crypto'
import dns from 'node:dns'
import fsSync from 'node:fs'
import { promises as fs } from 'node:fs'
import express from 'express'
import jwt from 'jsonwebtoken'
import { logBusinessEvent } from './logBusinessEvent.js'
import mongoose from 'mongoose'
import { connectMongo } from './db.js'
import sendVerificationEmail, {
  buildVerificationData,
  generateVerificationCode,
  verifyCode,
} from './sendVerificationEmail.js'

let ensureUsersIndexesPromise = null
async function ensureUsersIndexes(usersCollection) {
  if (ensureUsersIndexesPromise) return ensureUsersIndexesPromise
  ensureUsersIndexesPromise = (async () => {
    // Best-effort: avoid duplicate TG users under concurrent logins.
    //
    // IMPORTANT: telegramUserId is absent for email/password users.
    // A non-sparse unique index would treat missing values as null and break signups.
    // If an old index exists without sparse/partial settings, self-heal it.
    try {
      const indexes = await usersCollection.indexes()
      const tgIdx = Array.isArray(indexes) ? indexes.find((i) => i?.name === 'telegramUserId_1') : null
      const needsFix =
        tgIdx &&
        tgIdx.unique === true &&
        tgIdx.sparse !== true &&
        !(tgIdx.partialFilterExpression && typeof tgIdx.partialFilterExpression === 'object')
      if (needsFix) {
        await usersCollection.dropIndex('telegramUserId_1').catch(() => {})
      }
    } catch {
      // ignore
    }
    await usersCollection.createIndex({ telegramUserId: 1 }, { unique: true, sparse: true })
    // Best-effort: enforce unique email identities (email-based auth).
    // Sparse allows multiple docs without email field.
    await usersCollection.createIndex({ email: 1 }, { unique: true, sparse: true })
  })().catch((e) => {
    // Don't block auth if index creation fails (e.g. missing permissions).
    ensureUsersIndexesPromise = null
    console.warn('[authApi] users indexes ensure failed', e instanceof Error ? e.message : String(e))
  })
  return ensureUsersIndexesPromise
}

// Prefer IPv4 for SMTP connections to avoid IPv6 blackhole timeouts
// (common in some corporate/home networks on Windows).
try {
  dns.setDefaultResultOrder('ipv4first')
} catch {
  // ignore (older Node versions)
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function base64Url(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function newToken() {
  return base64Url(crypto.randomBytes(32))
}

function normalizePhone(phone) {
  return String(phone || '').trim()
}

function isStrongEnoughPassword(password) {
  const p = String(password || '')
  // Keep minimal to avoid rejecting legit passphrases. Frontend can be stricter.
  return p.length >= 6 && p.length <= 200
}

function b64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

function fromB64(str) {
  return Buffer.from(String(str || ''), 'base64')
}

async function scryptAsync(password, salt, keylen, opts) {
  return await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (err, derivedKey) => {
      if (err) return reject(err)
      resolve(derivedKey)
    })
  })
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const key = await scryptAsync(String(password), salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })
  return `scrypt$${b64(salt)}$${b64(key)}`
}

async function verifyPassword(password, stored) {
  const raw = String(stored || '')
  // Preferred format: scrypt$<salt_b64>$<hash_b64>
  if (raw.includes('$')) {
    const parts = raw.split('$')
    if (parts.length !== 3) return false
    const [algo, saltB64, hashB64] = parts
    if (algo !== 'scrypt') return false
    const salt = fromB64(saltB64)
    const expected = fromB64(hashB64)
    if (!salt.length || !expected.length) return false
    const got = await scryptAsync(String(password), salt, expected.length, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    })
    try {
      return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))
    } catch {
      return false
    }
  }

  // Backward-compatible: some older clients stored sha256(password) in base64.
  // (Matches frontend sha256Base64 implementation.)
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(raw)) {
    const got = crypto.createHash('sha256').update(String(password)).digest('base64')
    try {
      return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(raw))
    } catch {
      return false
    }
  }

  return false
}

function isHttpsReq(req) {
  return (
    Boolean(req.secure) ||
    String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' ||
    process.env.NODE_ENV === 'production'
  )
}

function setAuthCookie(req, res, token) {
  const isHttps = isHttpsReq(req)
  res.cookie('tf_token', token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? 'none' : 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  })
}

function toPublicUser(userDoc) {
  const telegramUserId =
    typeof userDoc?.telegramUserId === 'string' && userDoc.telegramUserId ? userDoc.telegramUserId : null
  const publicId = telegramUserId ? `tg_${telegramUserId}` : String(userDoc?._id)
  const fullName =
    (typeof userDoc?.fullName === 'string' && userDoc.fullName.trim()) ||
    [userDoc?.firstName, userDoc?.lastName].filter(Boolean).join(' ').trim() ||
    userDoc?.username ||
    (telegramUserId ? `tg_${telegramUserId}` : String(userDoc?._id))

  return {
    id: publicId,
    role: typeof userDoc?.role === 'string' && userDoc.role ? userDoc.role : 'pending',
    telegramUserId,
    fullName,
    phone: typeof userDoc?.phone === 'string' ? userDoc.phone : '',
    email: typeof userDoc?.email === 'string' ? userDoc.email : '',
    emailVerified: typeof userDoc?.emailVerified === 'boolean' ? userDoc.emailVerified : true,
    username: userDoc?.username ?? null,
    photoUrl: userDoc?.photoUrl ?? null,
    mongoId: userDoc?._id ? String(userDoc._id) : null,
  }
}

// --- Telegram Login Widget signature verification helpers ---
function buildTelegramDataCheckString(tg) {
  // data_check_string: include all received fields except "hash"
  // sort keys, format: key=value\nkey=value
  return Object.keys(tg)
    .filter((k) => k !== 'hash' && tg[k] !== undefined && tg[k] !== null)
    .sort()
    .map((k) => `${k}=${String(tg[k])}`)
    .join('\n')
}

function verifyTelegramLogin(tg, botToken) {
  if (!botToken) return { ok: false, error: 'telegram_bot_token_missing' }
  if (!tg || typeof tg !== 'object') return { ok: false, error: 'invalid_payload' }
  if (!tg.id || !tg.auth_date || !tg.hash) return { ok: false, error: 'missing_fields' }

  // optional: защита от старых логинов (например 1 день)
  const authDate = Number(tg.auth_date)
  if (!Number.isFinite(authDate)) return { ok: false, error: 'invalid_auth_date' }
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - authDate) > 86400) return { ok: false, error: 'auth_date_too_old' }

  const dataCheckString = buildTelegramDataCheckString(tg)
  // IMPORTANT: secret key is sha256(bot_token) as BYTES (not hex string)
  const secretKey = crypto.createHash('sha256').update(botToken).digest()
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  const providedHash = String(tg.hash)

  // compare hashes safely
  try {
    const a = Buffer.from(expectedHash, 'hex')
    const b = Buffer.from(providedHash, 'hex')
    if (a.length !== b.length) return { ok: false, error: 'hash_mismatch' }
    if (!crypto.timingSafeEqual(a, b)) return { ok: false, error: 'hash_mismatch' }
  } catch {
    return { ok: false, error: 'hash_mismatch' }
  }

  return { ok: true }
}

const FRONT_BASE = process.env.FRONTEND_BASE_URL || 'https://nativki.ru'

function logVerifyLink(email, token) {
  const url = `${FRONT_BASE}/verify-email?token=${encodeURIComponent(token)}`
  const line = `${new Date().toISOString()} email=${email} url=${url}\n`
  fsSync.mkdirSync('/var/log/taskflow', { recursive: true })
  fsSync.appendFileSync('/var/log/taskflow/verify-links.log', line, 'utf8')
  return url
}

async function readJson(filePath, fallback) {
  try {
    const txt = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(txt)
  } catch {
    return fallback
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

export function createAuthApi({ dataDir, appBaseUrl, audit = null, logEvent = null }) {
  const router = express.Router()

  const DATA_DIR = dataDir
  const VERIFICATIONS_FILE = path.join(DATA_DIR, 'emailVerifications.json')
  const VERIFIED_FILE = path.join(DATA_DIR, 'verifiedEmails.json')
  const PENDING_FILE = path.join(DATA_DIR, 'pendingSignups.json')

  async function ensureStorage() {
    await fs.mkdir(DATA_DIR, { recursive: true })
    const v = await readJson(VERIFICATIONS_FILE, null)
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      await writeJson(VERIFICATIONS_FILE, {})
    }
    const ve = await readJson(VERIFIED_FILE, null)
    if (!ve || typeof ve !== 'object' || Array.isArray(ve)) {
      await writeJson(VERIFIED_FILE, {})
    }
    const ps = await readJson(PENDING_FILE, null)
    if (!ps || typeof ps !== 'object' || Array.isArray(ps)) {
      await writeJson(PENDING_FILE, {})
    }
  }

  const ready = ensureStorage().catch((e) => {
    console.error('[authApi] ensureStorage failed', e)
    throw e
  })

  router.use(async (_req, _res, next) => {
    try {
      await ready
      next()
    } catch (e) {
      next(e)
    }
  })

  router.use(express.json({ limit: '1mb' }))

  router.post('/api/auth/login', async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body?.email)
      const password = typeof req.body?.password === 'string' ? req.body.password : ''
      if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' })
      if (!password) return res.status(400).json({ error: 'missing_password' })

      const JWT_SECRET = process.env.JWT_SECRET
      if (!JWT_SECRET) return res.status(500).json({ error: 'server_not_configured' })

      const conn = await connectMongo()
      if (!conn?.enabled || mongoose.connection.readyState !== 1) {
        return res.status(500).json({ error: 'mongo_not_available' })
      }
      const db = mongoose.connection.db
      if (!db) return res.status(500).json({ error: 'mongo_db_missing' })
      const users = db.collection('users')
      await ensureUsersIndexes(users)

      const userDoc = await users.findOne({ email }, { readPreference: 'primary' })
      if (!userDoc) return res.status(401).json({ error: 'invalid_credentials' })
      const stored = userDoc.passwordHash
      if (typeof stored !== 'string' || !stored) return res.status(401).json({ error: 'invalid_credentials' })
      const ok = await verifyPassword(password, stored).catch(() => false)
      if (!ok) return res.status(401).json({ error: 'invalid_credentials' })

      const token = jwt.sign({ sub: String(userDoc._id), email }, JWT_SECRET, { expiresIn: '30d' })
      setAuthCookie(req, res, token)

      const sourceHeader = req.headers['x-event-source'] ?? null
      const source = typeof sourceHeader === 'string' && sourceHeader.trim() ? sourceHeader.trim() : 'app'
      await logBusinessEvent({
        req,
        event: 'USER_LOGIN',
        actor: String(userDoc._id),
        target: null,
        meta: { method: 'email', source },
      })

      res.json({ token, user: toPublicUser(userDoc) })
    } catch (e) {
      next(e)
    }
  })

  // Email/password auth that creates a pending signup and sends a verification code.
  router.post('/api/auth/register-email', async (req, res, next) => {
    try {
      const role = String(req.body?.role || '').trim()
      const fullName = String(req.body?.fullName || '').trim()
      const phone = normalizePhone(req.body?.phone)
      const email = normalizeEmail(req.body?.email)
      const password = typeof req.body?.password === 'string' ? req.body.password : ''

      if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' })
      if (role !== 'customer' && role !== 'executor') return res.status(400).json({ error: 'invalid_role' })
      if (!fullName) return res.status(400).json({ error: 'missing_fullName' })
      if (!phone) return res.status(400).json({ error: 'missing_phone' })
      if (!password) return res.status(400).json({ error: 'missing_password' })
      if (!isStrongEnoughPassword(password)) return res.status(400).json({ error: 'weak_password' })

      const conn = await connectMongo()
      if (!conn?.enabled || mongoose.connection.readyState !== 1) {
        return res.status(500).json({ error: 'mongo_not_available' })
      }
      const db = mongoose.connection.db
      if (!db) return res.status(500).json({ error: 'mongo_db_missing' })
      const users = db.collection('users')
      await ensureUsersIndexes(users)

      const existing = await users.findOne({ email }, { readPreference: 'primary' })
      if (existing) return res.status(409).json({ error: 'email_taken' })

      const passwordHash = await hashPassword(password)

      const verified = await readJson(VERIFIED_FILE, {})
      if (verified[email]) return res.status(409).json({ error: 'email_taken' })

      const pending = await readJson(PENDING_FILE, {})
      if (pending[email]) return res.status(409).json({ error: 'email_pending' })

      const token = newToken()
      const createdAt = new Date().toISOString()
      const code = generateVerificationCode()
      const verification = buildVerificationData({ token, code, ttlMs: 10 * 60 * 1000 })

      pending[email] = {
        role,
        fullName,
        phone,
        email,
        passwordHash,
        createdAt,
        verification: {
          token,
          codeHash: verification.codeHash,
          expiresAt: verification.expiresAt,
        },
      }
      await writeJson(PENDING_FILE, pending)

      const verifications = await readJson(VERIFICATIONS_FILE, {})
      verifications[token] = { email, createdAt, usedAt: null, expiresAt: verification.expiresAt }
      await writeJson(VERIFICATIONS_FILE, verifications)

      const verifyUrl = logVerifyLink(email, token)
      const emailLog = String(process.env.RESEND_LOG || '').trim() === '1'
      if (emailLog) console.log('[email] sending code to:', email)
      try {
        const r = await sendVerificationEmail(email, { code, verifyUrl, ttlMinutes: 10 })
        if (emailLog) console.log('[email] resend ok:', r)
        if (!r?.delivered) console.warn('[email] resend not delivered:', r)
      } catch (err) {
        console.error('[email] resend error:', err)
      }

      audit?.(req, 'auth.register_email', { actor: { email, role }, meta: { method: 'email', verification: 'code' } })
      res.json({ ok: true })
    } catch (e) {
      next(e)
    }
  })

  router.post('/api/auth/register', async (req, res, next) => {
    try {
      const role = String(req.body?.role || '').trim()
      const fullName = String(req.body?.fullName || '').trim()
      const phone = String(req.body?.phone || '').trim()
      const email = normalizeEmail(req.body?.email)
      const company = typeof req.body?.company === 'string' ? req.body.company.trim() : ''
      const passwordHash = String(req.body?.passwordHash || '').trim()

      if (!email || !isValidEmail(email)) {
        audit?.(req, 'auth.register', { actor: { email }, result: 'error', meta: { error: 'invalid_email' } })
        return res.status(400).json({ error: 'invalid_email' })
      }
      if (role !== 'customer' && role !== 'executor') {
        audit?.(req, 'auth.register', { actor: { email }, result: 'error', meta: { error: 'invalid_role' } })
        return res.status(400).json({ error: 'invalid_role' })
      }
      if (!fullName) {
        audit?.(req, 'auth.register', { actor: { email, role }, result: 'error', meta: { error: 'missing_fullName' } })
        return res.status(400).json({ error: 'missing_fullName' })
      }
      if (!phone) {
        audit?.(req, 'auth.register', { actor: { email, role }, result: 'error', meta: { error: 'missing_phone' } })
        return res.status(400).json({ error: 'missing_phone' })
      }
      if (!passwordHash) {
        audit?.(req, 'auth.register', { actor: { email, role }, result: 'error', meta: { error: 'missing_passwordHash' } })
        return res.status(400).json({ error: 'missing_passwordHash' })
      }

      const verified = await readJson(VERIFIED_FILE, {})
      if (verified[email]) {
        audit?.(req, 'auth.register', { actor: { email, role }, result: 'error', meta: { error: 'email_taken' } })
        return res.status(409).json({ error: 'email_taken' })
      }

      const pending = await readJson(PENDING_FILE, {})
      if (pending[email]) {
        audit?.(req, 'auth.register', { actor: { email, role }, result: 'error', meta: { error: 'email_pending' } })
        return res.status(409).json({ error: 'email_pending' })
      }

      const token = newToken()
      const createdAt = new Date().toISOString()
      const code = generateVerificationCode()
      const verification = buildVerificationData({ token, code, ttlMs: 10 * 60 * 1000 })

      pending[email] = {
        role,
        fullName,
        phone,
        email,
        company: company || undefined,
        passwordHash,
        createdAt,
        verification: {
          token,
          codeHash: verification.codeHash,
          expiresAt: verification.expiresAt,
        },
      }
      await writeJson(PENDING_FILE, pending)

      const verifications = await readJson(VERIFICATIONS_FILE, {})
      verifications[token] = { email, createdAt, usedAt: null, expiresAt: verification.expiresAt }
      await writeJson(VERIFICATIONS_FILE, verifications)

      const verifyUrl = logVerifyLink(email, token)
      const emailLog = String(process.env.RESEND_LOG || '').trim() === '1'
      if (emailLog) console.log('[authApi] sending verification email (register)', { email })
      const delivery = await sendVerificationEmail(email, { code, verifyUrl, ttlMinutes: 10 })
      if (emailLog) console.log('[authApi] verification email result (register):', delivery)
      if (!delivery?.delivered) console.warn('[authApi] email not delivered, fallback to console', delivery)
      if (!delivery?.delivered) console.warn('[authApi] verification link:', verifyUrl)

      audit?.(req, 'auth.register', {
        actor: { email, role },
        meta: {
          delivery: delivery?.delivered ? delivery.channel : 'console',
          reason: delivery?.delivered ? null : delivery?.reason,
        },
      })
      res.json({ ok: true })
    } catch (e) {
      audit?.(req, 'auth.register', {
        actor: { email: normalizeEmail(req.body?.email) },
        result: 'error',
        meta: { error: e instanceof Error ? e.message : String(e) },
      })
      next(e)
    }
  })

  router.post('/api/auth/send-verification', async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body?.email)
      if (!email || !isValidEmail(email)) {
        audit?.(req, 'auth.send_verification', { actor: { email }, result: 'error', meta: { error: 'invalid_email' } })
        return res.status(400).json({ error: 'invalid_email' })
      }

      const pending = await readJson(PENDING_FILE, {})
      if (!pending[email]) {
        audit?.(req, 'auth.send_verification', { actor: { email }, result: 'error', meta: { error: 'no_pending_signup' } })
        return res.status(404).json({ error: 'no_pending_signup' })
      }

      const token = newToken()
      const createdAt = new Date().toISOString()
      const code = generateVerificationCode()
      const verification = buildVerificationData({ token, code, ttlMs: 10 * 60 * 1000 })

      // Overwrite latest verification data in pending record.
      pending[email].verification = { token, codeHash: verification.codeHash, expiresAt: verification.expiresAt }
      await writeJson(PENDING_FILE, pending)

      const verifications = await readJson(VERIFICATIONS_FILE, {})
      verifications[token] = { email, createdAt, usedAt: null, expiresAt: verification.expiresAt }
      await writeJson(VERIFICATIONS_FILE, verifications)

      const verifyUrl = logVerifyLink(email, token)
      const emailLog = String(process.env.RESEND_LOG || '').trim() === '1'
      if (emailLog) console.log('[authApi] sending verification email (send-verification)', { email })
      const delivery = await sendVerificationEmail(email, { code, verifyUrl, ttlMinutes: 10 })
      if (emailLog) console.log('[authApi] verification email result (send-verification):', delivery)
      if (!delivery?.delivered) console.warn('[authApi] email not delivered, fallback to console', delivery)
      if (!delivery?.delivered) console.warn('[authApi] verification link:', verifyUrl)

      audit?.(req, 'auth.send_verification', {
        actor: { email },
        meta: {
          delivery: delivery?.delivered ? delivery.channel : 'console',
          reason: delivery?.delivered ? null : delivery?.reason,
        },
      })
      res.json({ ok: true })
    } catch (e) {
      audit?.(req, 'auth.send_verification', {
        actor: { email: normalizeEmail(req.body?.email) },
        result: 'error',
        meta: { error: e instanceof Error ? e.message : String(e) },
      })
      next(e)
    }
  })

  router.post('/api/auth/telegram/login', async (req, res, next) => {
    try {
      const tg = req.body || {}
      const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
      const v = verifyTelegramLogin(tg, BOT_TOKEN)
      if (!v.ok) return res.status(401).json({ error: v.error })

      const telegramUserId = String(tg.id)
      let userDoc = null
      try {
        const conn = await connectMongo()
        if (!conn?.enabled || mongoose.connection.readyState !== 1) {
          return res.status(500).json({ error: 'mongo_not_available' })
        }

        // Create/find user in Mongo
        const db = mongoose.connection.db
        if (!db) return res.status(500).json({ error: 'mongo_db_missing' })
        const users = db.collection('users')

        // Atomic upsert prevents races and guarantees we have the document for JWT.
        const now = new Date()
        const update = {
          $set: {
            username: tg.username || null,
            firstName: tg.first_name || null,
            lastName: tg.last_name || null,
            photoUrl: tg.photo_url || null,
            updatedAt: now,
          },
          $setOnInsert: {
            telegramUserId,
            role: 'pending',
            createdAt: now,
          },
        }
        const upsertRes = await users.findOneAndUpdate({ telegramUserId }, update, {
          upsert: true,
          returnDocument: 'after',
        })
        // Mongoose/native driver interop can return either:
        // - the updated document directly, or
        // - a { value: doc } result object (findAndModify-style).
        userDoc =
          upsertRes && typeof upsertRes === 'object' && 'value' in upsertRes
            ? upsertRes.value ?? null
            : upsertRes ?? null

        // Self-heal: if DB already contains duplicates for this telegramUserId,
        // pick a canonical doc and delete the rest so role persists across logins.
        const dupes = await users
          .find(
            { telegramUserId },
            { projection: { _id: 1, role: 1, createdAt: 1 }, readPreference: 'primary' },
          )
          .toArray()
        if (dupes.length > 1) {
          const normalized = dupes.map((d) => {
            const r = typeof d.role === 'string' && d.role ? d.role : 'pending'
            const createdAtMs =
              d.createdAt instanceof Date
                ? d.createdAt.getTime()
                : typeof d.createdAt === 'string'
                  ? Date.parse(d.createdAt)
                  : Number.POSITIVE_INFINITY
            return { ...d, _normRole: r, _createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Number.POSITIVE_INFINITY }
          })
          const chosen =
            normalized.find((d) => d._normRole !== 'pending') ??
            normalized.slice().sort((a, b) => a._createdAtMs - b._createdAtMs)[0]

          if (chosen?._id) {
            // Keep profile fields up to date on canonical doc.
            await users.updateOne(
              { _id: chosen._id },
              { $set: { username: tg.username || null, firstName: tg.first_name || null, lastName: tg.last_name || null, photoUrl: tg.photo_url || null, updatedAt: now } },
            )
            const canonical = await users.findOne({ _id: chosen._id }, { readPreference: 'primary' })
            if (canonical) userDoc = canonical

            await users.deleteMany({ telegramUserId, _id: { $ne: chosen._id } })
          }
        }

        // Best-effort: after dedupe, try to enforce uniqueness for the future.
        await ensureUsersIndexes(users)
      } catch (e) {
        console.error('[authApi] TG login mongo error', e)
        return res.status(500).json({ error: 'mongo_error', message: e instanceof Error ? e.message : String(e) })
      }

      if (!userDoc?._id) {
        console.error('[authApi] TG login: userDoc missing _id', { telegramUserId, userDoc })
        return res.status(500).json({ error: 'user_create_failed' })
      }

      const fullName =
        [tg.first_name, tg.last_name].filter(Boolean).join(' ').trim() || tg.username || `tg_${telegramUserId}`

      // Минимальный user для фронта. Роль пока неизвестна -> pending.
      const user = {
        // Important: frontend expects stable id like tg_<id>
        // JWT still uses Mongo _id in `sub` for existence checks.
        id: `tg_${telegramUserId}`,
        role: typeof userDoc.role === 'string' && userDoc.role ? userDoc.role : 'pending',
        fullName,
        phone: '',
        email: '',
        emailVerified: true,
        telegramUserId,
        username: tg.username || null,
        photoUrl: tg.photo_url || null,
        mongoId: String(userDoc._id),
      }

      // JWT
      const JWT_SECRET = process.env.JWT_SECRET
      if (!JWT_SECRET) return res.status(500).json({ error: 'server_not_configured' })
      const token = jwt.sign({ sub: String(userDoc._id), telegramUserId }, JWT_SECRET, { expiresIn: '30d' })

      // Also set cookie for same-origin API calls (helps when frontend doesn't attach Authorization header).
      // For cross-site frontends (different domain), cookies must be SameSite=None;Secure and frontend must use credentials: 'include'.
      setAuthCookie(req, res, token)

      return res.json({ token, user })
    } catch (e) {
      next(e)
    }
  })

  router.get('/api/auth/verify-email', async (req, res, next) => {
    try {
      const token = String(req.query?.token || '').trim()
      if (!token) {
        audit?.(req, 'auth.verify_email', { result: 'error', meta: { error: 'missing_token' } })
        return res.status(400).json({ error: 'missing_token' })
      }

      const verifications = await readJson(VERIFICATIONS_FILE, {})
      const record = verifications[token] ?? null
      if (!record || typeof record?.email !== 'string') {
        audit?.(req, 'auth.verify_email', { result: 'error', meta: { error: 'invalid_token' } })
        return res.status(400).json({ error: 'invalid_token' })
      }
      if (!record.usedAt && record.expiresAt) {
        const expMs = Date.parse(String(record.expiresAt))
        if (Number.isFinite(expMs) && Date.now() > expMs) {
          audit?.(req, 'auth.verify_email', { actor: { email: record.email }, result: 'error', meta: { error: 'token_expired' } })
          return res.status(400).json({ error: 'token_expired' })
        }
      }
      if (record.usedAt) {
        // Idempotent verify: allow multiple visits / refresh without breaking UX.
        const verified = await readJson(VERIFIED_FILE, {})
        if (verified[record.email]) {
          const pending = await readJson(PENDING_FILE, {})
          audit?.(req, 'auth.verify_email', {
            actor: { email: record.email },
            meta: { alreadyVerified: true },
          })
          return res.json({ email: record.email, alreadyVerified: true, pending: pending[record.email] ?? null })
        }
        // If verification record was marked used but email wasn't recorded for some reason, treat as error.
        audit?.(req, 'auth.verify_email', {
          actor: { email: record.email },
          result: 'error',
          meta: { error: 'token_used' },
        })
        return res.status(400).json({ error: 'token_used' })
      }

      record.usedAt = new Date().toISOString()
      verifications[token] = record
      await writeJson(VERIFICATIONS_FILE, verifications)

      const verified = await readJson(VERIFIED_FILE, {})
      verified[record.email] = { verifiedAt: record.usedAt }
      await writeJson(VERIFIED_FILE, verified)

      const pending = await readJson(PENDING_FILE, {})
      audit?.(req, 'auth.verify_email', {
        actor: { email: record.email },
        meta: { alreadyVerified: false },
      })
      res.json({ email: record.email, alreadyVerified: false, pending: pending[record.email] ?? null })
    } catch (e) {
      audit?.(req, 'auth.verify_email', {
        result: 'error',
        meta: { error: e instanceof Error ? e.message : String(e) },
      })
      next(e)
    }
  })

  router.post('/api/auth/verify-email-code', async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body?.email)
      const code = String(req.body?.code || '').trim()

      if (!email || !isValidEmail(email)) {
        audit?.(req, 'auth.verify_email_code', { actor: { email }, result: 'error', meta: { error: 'invalid_email' } })
        return res.status(400).json({ error: 'invalid_email' })
      }
      if (!/^\d{6}$/.test(code)) {
        audit?.(req, 'auth.verify_email_code', { actor: { email }, result: 'error', meta: { error: 'invalid_code' } })
        return res.status(400).json({ error: 'invalid_code' })
      }

      const verified = await readJson(VERIFIED_FILE, {})
      if (verified[email]) {
        const pending = await readJson(PENDING_FILE, {})
        audit?.(req, 'auth.verify_email_code', { actor: { email }, meta: { alreadyVerified: true } })
        return res.json({ email, alreadyVerified: true, pending: pending[email] ?? null })
      }

      const pending = await readJson(PENDING_FILE, {})
      const p = pending[email] ?? null
      if (!p) {
        audit?.(req, 'auth.verify_email_code', { actor: { email }, result: 'error', meta: { error: 'no_pending_signup' } })
        return res.status(404).json({ error: 'no_pending_signup' })
      }

      const v = p?.verification ?? null
      if (!v || typeof v?.token !== 'string' || typeof v?.codeHash !== 'string') {
        audit?.(req, 'auth.verify_email_code', { actor: { email }, result: 'error', meta: { error: 'verification_not_requested' } })
        return res.status(400).json({ error: 'verification_not_requested' })
      }

      const expMs = Date.parse(String(v.expiresAt || ''))
      if (Number.isFinite(expMs) && Date.now() > expMs) {
        audit?.(req, 'auth.verify_email_code', { actor: { email }, result: 'error', meta: { error: 'code_expired' } })
        return res.status(400).json({ error: 'code_expired' })
      }

      const ok = verifyCode({ token: v.token, code, expectedHash: v.codeHash })
      if (!ok) {
        audit?.(req, 'auth.verify_email_code', { actor: { email }, result: 'error', meta: { error: 'invalid_code' } })
        return res.status(400).json({ error: 'invalid_code' })
      }

      const usedAt = new Date().toISOString()

      // Mark token record as used (best-effort).
      try {
        const verifications = await readJson(VERIFICATIONS_FILE, {})
        const record = verifications[v.token] ?? null
        if (record && !record.usedAt) {
          record.usedAt = usedAt
          verifications[v.token] = record
          await writeJson(VERIFICATIONS_FILE, verifications)
        }
      } catch {
        // ignore
      }

      const verified2 = await readJson(VERIFIED_FILE, {})
      verified2[email] = { verifiedAt: usedAt }
      await writeJson(VERIFIED_FILE, verified2)

      audit?.(req, 'auth.verify_email_code', { actor: { email }, meta: { alreadyVerified: false } })
      res.json({ email, alreadyVerified: false, pending: p })
    } catch (e) {
      audit?.(req, 'auth.verify_email_code', {
        actor: { email: normalizeEmail(req.body?.email) },
        result: 'error',
        meta: { error: e instanceof Error ? e.message : String(e) },
      })
      next(e)
    }
  })

  router.post('/api/auth/consume-pending', async (req, res, next) => {
    try {
      async function issueJwtForEmailUser(email) {
        const JWT_SECRET = process.env.JWT_SECRET
        if (!JWT_SECRET) return { ok: false, error: 'server_not_configured' }

        const conn = await connectMongo()
        if (!conn?.enabled || mongoose.connection.readyState !== 1) return { ok: false, error: 'mongo_not_available' }
        const db = mongoose.connection.db
        if (!db) return { ok: false, error: 'mongo_db_missing' }
        const users = db.collection('users')
        await ensureUsersIndexes(users)

        const userDoc = await users.findOne({ email }, { readPreference: 'primary' })
        if (!userDoc) return { ok: false, error: 'user_not_found' }

        const token = jwt.sign({ sub: String(userDoc._id), email }, JWT_SECRET, { expiresIn: '30d' })
        setAuthCookie(req, res, token)
        return { ok: true, token, user: toPublicUser(userDoc) }
      }

      async function createUserFromPending(p) {
        const email = normalizeEmail(p?.email)
        if (!email || !isValidEmail(email)) return { ok: false, error: 'invalid_email' }

        const JWT_SECRET = process.env.JWT_SECRET
        if (!JWT_SECRET) return { ok: false, error: 'server_not_configured' }

        const conn = await connectMongo()
        if (!conn?.enabled || mongoose.connection.readyState !== 1) return { ok: false, error: 'mongo_not_available' }
        const db = mongoose.connection.db
        if (!db) return { ok: false, error: 'mongo_db_missing' }
        const users = db.collection('users')
        await ensureUsersIndexes(users)

        const existing = await users.findOne({ email }, { readPreference: 'primary' })
        if (existing) {
          const token = jwt.sign({ sub: String(existing._id), email }, JWT_SECRET, { expiresIn: '30d' })
          setAuthCookie(req, res, token)
          return { ok: true, token, user: toPublicUser(existing), existed: true }
        }

        const now = new Date()
        const createdAt =
          typeof p?.createdAt === 'string' && Number.isFinite(Date.parse(p.createdAt)) ? new Date(p.createdAt) : now

        const role = p?.role === 'customer' || p?.role === 'executor' ? p.role : 'pending'
        const fullName = typeof p?.fullName === 'string' ? p.fullName.trim() : ''
        const phone = typeof p?.phone === 'string' ? p.phone.trim() : ''
        const passwordHash = typeof p?.passwordHash === 'string' ? p.passwordHash.trim() : ''

        if (!fullName) return { ok: false, error: 'missing_fullName' }
        if (!phone) return { ok: false, error: 'missing_phone' }
        if (!passwordHash) return { ok: false, error: 'missing_passwordHash' }

        const doc = {
          role,
          fullName,
          phone,
          email,
          company: typeof p?.company === 'string' && p.company.trim() ? p.company.trim() : null,
          emailVerified: true,
          passwordHash,
          createdAt,
          updatedAt: now,
        }

        try {
          const insertRes = await users.insertOne(doc)
          const userDoc = await users.findOne({ _id: insertRes.insertedId }, { readPreference: 'primary' })
          if (!userDoc) return { ok: false, error: 'user_create_failed' }
          const token = jwt.sign({ sub: String(userDoc._id), email }, JWT_SECRET, { expiresIn: '30d' })
          setAuthCookie(req, res, token)
          return { ok: true, token, user: toPublicUser(userDoc), existed: false }
        } catch (e) {
          // Race / retry-safe: if another request created user, just fetch it.
          const userDoc = await users.findOne({ email }, { readPreference: 'primary' })
          if (!userDoc) return { ok: false, error: 'user_create_failed' }
          const token = jwt.sign({ sub: String(userDoc._id), email }, JWT_SECRET, { expiresIn: '30d' })
          setAuthCookie(req, res, token)
          return { ok: true, token, user: toPublicUser(userDoc), existed: true }
        }
      }

      const token = String(req.body?.token || '').trim()
      if (token) {
        const verifications = await readJson(VERIFICATIONS_FILE, {})
        const record = verifications[token] ?? null
        if (!record || typeof record?.email !== 'string') {
          audit?.(req, 'auth.consume_pending', { result: 'error', meta: { error: 'invalid_token' } })
          return res.status(400).json({ error: 'invalid_token' })
        }
        if (!record.usedAt) {
          audit?.(req, 'auth.consume_pending', {
            actor: { email: record.email },
            result: 'error',
            meta: { error: 'not_verified' },
          })
          return res.status(400).json({ error: 'not_verified' })
        }

        const pending = await readJson(PENDING_FILE, {})
        const p = pending[record.email] ?? null

        // Create/login user if we still have pending payload.
        if (p) {
          const created = await createUserFromPending(p)
          if (!created.ok) return res.status(500).json({ error: created.error })

          delete pending[record.email]
          await writeJson(PENDING_FILE, pending)

          audit?.(req, 'auth.consume_pending', { actor: { email: record.email }, meta: { login: true, method: 'token' } })
          return res.json({ ok: true, token: created.token, user: created.user })
        }

        // Idempotent: if pending already consumed, still allow login if user exists.
        const issued = await issueJwtForEmailUser(record.email)
        if (issued.ok) {
          audit?.(req, 'auth.consume_pending', {
            actor: { email: record.email },
            meta: { login: true, method: 'token', idempotent: true },
          })
          return res.json({ ok: true, token: issued.token, user: issued.user })
        }

        audit?.(req, 'auth.consume_pending', { actor: { email: record.email }, meta: { login: false, method: 'token' } })
        return res.json({ ok: true })
      }

      const email = normalizeEmail(req.body?.email)
      const code = String(req.body?.code || '').trim()
      if (!email || !isValidEmail(email)) {
        audit?.(req, 'auth.consume_pending', { actor: { email }, result: 'error', meta: { error: 'invalid_email' } })
        return res.status(400).json({ error: 'invalid_email' })
      }
      if (!/^\d{6}$/.test(code)) {
        audit?.(req, 'auth.consume_pending', { actor: { email }, result: 'error', meta: { error: 'invalid_code' } })
        return res.status(400).json({ error: 'invalid_code' })
      }

      const pending = await readJson(PENDING_FILE, {})
      const p = pending[email] ?? null
      if (!p) {
        audit?.(req, 'auth.consume_pending', { actor: { email }, result: 'error', meta: { error: 'no_pending_signup' } })
        return res.status(404).json({ error: 'no_pending_signup' })
      }
      const v = p?.verification ?? null
      if (!v || typeof v?.token !== 'string' || typeof v?.codeHash !== 'string') {
        audit?.(req, 'auth.consume_pending', { actor: { email }, result: 'error', meta: { error: 'verification_not_requested' } })
        return res.status(400).json({ error: 'verification_not_requested' })
      }

      const expMs = Date.parse(String(v.expiresAt || ''))
      if (Number.isFinite(expMs) && Date.now() > expMs) {
        audit?.(req, 'auth.consume_pending', { actor: { email }, result: 'error', meta: { error: 'code_expired' } })
        return res.status(400).json({ error: 'code_expired' })
      }

      const ok = verifyCode({ token: v.token, code, expectedHash: v.codeHash })
      if (!ok) {
        audit?.(req, 'auth.consume_pending', { actor: { email }, result: 'error', meta: { error: 'invalid_code' } })
        return res.status(400).json({ error: 'invalid_code' })
      }

      const usedAt = new Date().toISOString()

      // Mark verified (best-effort) and mark token used.
      try {
        const verifications = await readJson(VERIFICATIONS_FILE, {})
        const record = verifications[v.token] ?? null
        if (record && !record.usedAt) {
          record.usedAt = usedAt
          verifications[v.token] = record
          await writeJson(VERIFICATIONS_FILE, verifications)
        }
      } catch {
        // ignore
      }

      const verified = await readJson(VERIFIED_FILE, {})
      verified[email] = { verifiedAt: usedAt }
      await writeJson(VERIFIED_FILE, verified)

      const created = await createUserFromPending(p)
      if (!created.ok) return res.status(500).json({ error: created.error })

      delete pending[email]
      await writeJson(PENDING_FILE, pending)

      const sourceHeader = req.headers['x-event-source'] ?? null
      const source = typeof sourceHeader === 'string' && sourceHeader.trim() ? sourceHeader.trim() : 'app'
      await logBusinessEvent({
        req,
        event: 'USER_REGISTER',
        actor: created?.user?.mongoId ?? email,
        target: null,
        meta: { method: 'email', source, existed: Boolean(created.existed) },
      }).catch(() => {})

      audit?.(req, 'auth.consume_pending', { actor: { email }, meta: { login: true, method: 'code' } })
      res.json({ ok: true, token: created.token, user: created.user })
    } catch (e) {
      audit?.(req, 'auth.consume_pending', {
        result: 'error',
        meta: { error: e instanceof Error ? e.message : String(e) },
      })
      next(e)
    }
  })

  router.get('/api/auth/is-verified', async (req, res, next) => {
    try {
      const email = normalizeEmail(req.query?.email)
      if (!email || !isValidEmail(email)) return res.json({ verified: false })
      const verified = await readJson(VERIFIED_FILE, {})
      res.json({ verified: Boolean(verified[email]) })
    } catch (e) {
      next(e)
    }
  })

  router.use((error, _req, res, _next) => {
    console.error('[authApi] server error', error)
    res.status(500).json({ error: 'server_error' })
  })

  return router
}

