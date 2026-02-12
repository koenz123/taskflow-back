import path from 'node:path'
import crypto from 'node:crypto'
import dns from 'node:dns'
import { promises as fs } from 'node:fs'
import express from 'express'

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

export function createAuthApi({ dataDir, appBaseUrl }) {
  const router = express()

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

  router.post('/api/auth/register', async (req, res, next) => {
    try {
      const role = String(req.body?.role || '').trim()
      const fullName = String(req.body?.fullName || '').trim()
      const phone = String(req.body?.phone || '').trim()
      const email = normalizeEmail(req.body?.email)
      const company = typeof req.body?.company === 'string' ? req.body.company.trim() : ''
      const passwordHash = String(req.body?.passwordHash || '').trim()

      if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' })
      if (role !== 'customer' && role !== 'executor') return res.status(400).json({ error: 'invalid_role' })
      if (!fullName) return res.status(400).json({ error: 'missing_fullName' })
      if (!phone) return res.status(400).json({ error: 'missing_phone' })
      if (!passwordHash) return res.status(400).json({ error: 'missing_passwordHash' })

      const verified = await readJson(VERIFIED_FILE, {})
      if (verified[email]) return res.status(409).json({ error: 'email_taken' })

      const pending = await readJson(PENDING_FILE, {})
      if (pending[email]) return res.status(409).json({ error: 'email_pending' })

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

      const origin =
        (typeof req.headers?.origin === 'string' && req.headers.origin) ||
        (typeof req.headers?.host === 'string' && req.headers.host ? `http://${req.headers.host}` : null) ||
        null
      const base = String(origin || appBaseUrl || 'http://localhost:5173').replace(/\/+$/, '')
      const verifyUrl = `${base}/verify-email?token=${token}`
      const subject = 'Подтверждение почты / Email verification'
      const text = `Откройте ссылку, чтобы подтвердить почту:\n${verifyUrl}\n\nIf you did not request this, ignore this email.`

      const delivery = await trySendEmail({ to: email, subject, text })
      if (!delivery.delivered) {
        console.warn('[authApi] email not delivered, fallback to console', delivery)
        console.warn('[authApi] verification link:', verifyUrl)
      } else {
        console.log('[authApi] verification email sent to', email)
      }

      res.json({ ok: true })
    } catch (e) {
      next(e)
    }
  })

  router.post('/api/auth/send-verification', async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body?.email)
      if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' })

      const pending = await readJson(PENDING_FILE, {})
      if (!pending[email]) return res.status(404).json({ error: 'no_pending_signup' })

      const token = newToken()
      const createdAt = new Date().toISOString()
      const verifications = await readJson(VERIFICATIONS_FILE, {})
      verifications[token] = { email, createdAt, usedAt: null }
      await writeJson(VERIFICATIONS_FILE, verifications)

      const origin =
        (typeof req.headers?.origin === 'string' && req.headers.origin) ||
        (typeof req.headers?.host === 'string' && req.headers.host ? `http://${req.headers.host}` : null) ||
        null
      const base = String(origin || appBaseUrl || 'http://localhost:5173').replace(/\/+$/, '')
      const verifyUrl = `${base}/verify-email?token=${token}`
      const subject = 'Подтверждение почты / Email verification'
      const text = `Откройте ссылку, чтобы подтвердить почту:\n${verifyUrl}\n\nIf you did not request this, ignore this email.`

      const delivery = await trySendEmail({ to: email, subject, text })
      if (!delivery.delivered) {
        console.warn('[authApi] email not delivered, fallback to console', delivery)
        console.warn('[authApi] verification link:', verifyUrl)
      } else {
        console.log('[authApi] verification email sent to', email)
      }

      res.json({ ok: true })
    } catch (e) {
      next(e)
    }
  })

  router.get('/api/auth/verify-email', async (req, res, next) => {
    try {
      const token = String(req.query?.token || '').trim()
      if (!token) return res.status(400).json({ error: 'missing_token' })

      const verifications = await readJson(VERIFICATIONS_FILE, {})
      const record = verifications[token] ?? null
      if (!record || typeof record?.email !== 'string') return res.status(400).json({ error: 'invalid_token' })
      if (record.usedAt) {
        // Idempotent verify: allow multiple visits / refresh without breaking UX.
        const verified = await readJson(VERIFIED_FILE, {})
        if (verified[record.email]) {
          const pending = await readJson(PENDING_FILE, {})
          return res.json({ email: record.email, alreadyVerified: true, pending: pending[record.email] ?? null })
        }
        // If verification record was marked used but email wasn't recorded for some reason, treat as error.
        return res.status(400).json({ error: 'token_used' })
      }

      record.usedAt = new Date().toISOString()
      verifications[token] = record
      await writeJson(VERIFICATIONS_FILE, verifications)

      const verified = await readJson(VERIFIED_FILE, {})
      verified[record.email] = { verifiedAt: record.usedAt }
      await writeJson(VERIFIED_FILE, verified)

      const pending = await readJson(PENDING_FILE, {})
      res.json({ email: record.email, alreadyVerified: false, pending: pending[record.email] ?? null })
    } catch (e) {
      next(e)
    }
  })

  router.post('/api/auth/consume-pending', async (req, res, next) => {
    try {
      const token = String(req.body?.token || '').trim()
      if (!token) return res.status(400).json({ error: 'missing_token' })
      const verifications = await readJson(VERIFICATIONS_FILE, {})
      const record = verifications[token] ?? null
      if (!record || typeof record?.email !== 'string') return res.status(400).json({ error: 'invalid_token' })
      if (!record.usedAt) return res.status(400).json({ error: 'not_verified' })

      const pending = await readJson(PENDING_FILE, {})
      if (pending[record.email]) {
        delete pending[record.email]
        await writeJson(PENDING_FILE, pending)
      }
      res.json({ ok: true })
    } catch (e) {
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

