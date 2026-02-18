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

let ensureUsersIndexesPromise = null
async function ensureUsersIndexes(usersCollection) {
  if (ensureUsersIndexesPromise) return ensureUsersIndexesPromise
  ensureUsersIndexesPromise = (async () => {
    // Best-effort: avoid duplicate TG users under concurrent logins.
    await usersCollection.createIndex({ telegramUserId: 1 }, { unique: true })
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

async function trySendEmail({ to, subject, text }) {
  // Optional dependency. If not installed/configured, we fallback to console.
  let nodemailer = null
  try {
    const mod = await import('nodemailer')
    nodemailer = mod?.default ?? mod
  } catch {
    nodemailer = null
  }

  const SMTP_HOST = process.env.SMTP_HOST
  const SMTP_PORT = process.env.SMTP_PORT
  const SMTP_USER = process.env.SMTP_USER
  const SMTP_PASS = process.env.SMTP_PASS
  const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER

  if (!nodemailer) {
    return { delivered: false, reason: 'nodemailer_missing' }
  }
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
    return { delivered: false, reason: 'smtp_not_configured' }
  }

  const port = Number(SMTP_PORT)
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number.isFinite(port) ? port : 587,
    secure: Number.isFinite(port) ? port === 465 : false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Make timeouts explicit to fail fast with actionable errors.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  })

  try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to,
      subject,
      text,
    })
    return { delivered: true }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    // Do not fail registration if SMTP is unreachable.
    return { delivered: false, reason: 'smtp_send_failed', error: e.message }
  }
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
      const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''
      if (!userId) return res.status(400).json({ error: 'missing_userId' })

      const sourceHeader = req.headers['x-event-source'] ?? null
      const source = typeof sourceHeader === 'string' && sourceHeader.trim() ? sourceHeader.trim() : 'app'

      // Имитация логина: в реальном мире тут будет проверка пароля/токены и т.д.
      const user = { id: userId }

      // Business log (audit + Event storage)
      await logBusinessEvent({
        req,
        event: 'USER_LOGIN',
        actor: user.id,
        target: null,
        meta: { method: 'app', source },
      })

      res.json({ user })
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

      pending[email] = {
        role,
        fullName,
        phone,
        email,
        company: company || undefined,
        passwordHash,
        createdAt,
      }
      await writeJson(PENDING_FILE, pending)

      const verifications = await readJson(VERIFICATIONS_FILE, {})
      verifications[token] = { email, createdAt, usedAt: null }
      await writeJson(VERIFICATIONS_FILE, verifications)

      const verifyUrl = logVerifyLink(email, token)
      const subject = 'Подтверждение почты / Email verification'
      const text = `Откройте ссылку, чтобы подтвердить почту:\n${verifyUrl}\n\nIf you did not request this, ignore this email.`

      const delivery = await trySendEmail({ to: email, subject, text })
      if (!delivery.delivered) {
        console.warn('[authApi] email not delivered, fallback to console', delivery)
        console.warn('[authApi] verification link:', verifyUrl)
      }

      audit?.(req, 'auth.register', {
        actor: { email, role },
        meta: {
          delivery: delivery.delivered ? 'smtp' : 'console',
          reason: delivery.delivered ? null : delivery.reason,
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
      const verifications = await readJson(VERIFICATIONS_FILE, {})
      verifications[token] = { email, createdAt, usedAt: null }
      await writeJson(VERIFICATIONS_FILE, verifications)

      const verifyUrl = logVerifyLink(email, token)
      const subject = 'Подтверждение почты / Email verification'
      const text = `Откройте ссылку, чтобы подтвердить почту:\n${verifyUrl}\n\nIf you did not request this, ignore this email.`

      const delivery = await trySendEmail({ to: email, subject, text })
      if (!delivery.delivered) {
        console.warn('[authApi] email not delivered, fallback to console', delivery)
        console.warn('[authApi] verification link:', verifyUrl)
      }

      audit?.(req, 'auth.send_verification', {
        actor: { email },
        meta: {
          delivery: delivery.delivered ? 'smtp' : 'console',
          reason: delivery.delivered ? null : delivery.reason,
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
      const isHttps =
        Boolean(req.secure) ||
        String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' ||
        process.env.NODE_ENV === 'production'
      res.cookie('tf_token', token, {
        httpOnly: true,
        secure: isHttps,
        sameSite: isHttps ? 'none' : 'lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60 * 1000,
      })

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

  router.post('/api/auth/consume-pending', async (req, res, next) => {
    try {
      const token = String(req.body?.token || '').trim()
      if (!token) {
        audit?.(req, 'auth.consume_pending', { result: 'error', meta: { error: 'missing_token' } })
        return res.status(400).json({ error: 'missing_token' })
      }
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
      if (pending[record.email]) {
        delete pending[record.email]
        await writeJson(PENDING_FILE, pending)
      }
      audit?.(req, 'auth.consume_pending', { actor: { email: record.email } })
      res.json({ ok: true })
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

