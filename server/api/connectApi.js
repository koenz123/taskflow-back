import express from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import mongoose from 'mongoose'
import { tryResolveAuthUser } from '../auth/authSession.js'
import { requireAuth } from '../auth/auth.js'
import { connectMongo } from '../infra/db.js'
import {
  getConnectAuthUrl,
  exchangeConnectCode,
  getCallbackPath,
  isAllowed,
} from '../integrations/socialConnect.js'

const FRONT_BASE = String(process.env.FRONTEND_BASE_URL || process.env.PUBLIC_BASE_URL || 'https://nativki.ru').trim()
const API_BASE = String(process.env.PUBLIC_BASE_URL || process.env.API_BASE_URL || 'http://localhost:4000').trim()
const JWT_SECRET = process.env.JWT_SECRET || ''
const CONNECT_STATE_EXPIRY = '10m'
const VKID_STATE_TTL_MS = 10 * 60 * 1000

function trimSlash(s) {
  return typeof s === 'string' ? s.replace(/\/+$/, '') : ''
}

function resolveApiBase(req) {
  const env = trimSlash(API_BASE)
  // If API_BASE is explicitly configured (and not the default localhost), prefer it.
  if (env && !/localhost|127\.0\.0\.1/i.test(env)) return env

  const xfProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
  const proto = xfProto || req.protocol || 'https'
  const xfHost = String(req.headers?.['x-forwarded-host'] || '').split(',')[0].trim()
  const host = xfHost || String(req.headers?.host || '').trim()
  if (!host) return env || 'http://localhost:4000'
  return `${proto}://${host}`
}

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function sha256Base64url(value) {
  const h = crypto.createHash('sha256').update(value).digest()
  return base64url(h)
}

function makeVkIdCodeVerifier() {
  // 43..128 chars, a-zA-Z0-9_- (base64url fits)
  return base64url(crypto.randomBytes(48)) // ~64 chars
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
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

function normalizeStateStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value
}

function extractVkIdCallbackParams(req) {
  // VK ID can return either query params directly or JSON in ?payload=...
  const payloadRaw = typeof req.query?.payload === 'string' ? req.query.payload : null
  if (payloadRaw && payloadRaw.trim()) {
    try {
      const parsed = JSON.parse(payloadRaw)
      return {
        code: typeof parsed?.code === 'string' ? parsed.code : '',
        state: typeof parsed?.state === 'string' ? parsed.state : '',
        deviceId: typeof parsed?.device_id === 'string' ? parsed.device_id : '',
      }
    } catch {
      // ignore; fall through
    }
  }
  return {
    code: typeof req.query?.code === 'string' ? String(req.query.code) : '',
    state: typeof req.query?.state === 'string' ? String(req.query.state) : '',
    deviceId: typeof req.query?.device_id === 'string' ? String(req.query.device_id) : '',
  }
}

export function createConnectApi() {
  const router = express.Router()

  // GET /api/auth/connect/:platform — redirect to platform OAuth (requires auth)
  // If client sends Accept: application/json or ?json=1, we return { redirectUrl } so SPA can do window.location.href = redirectUrl (full navigation to social site).
  router.get('/api/auth/connect/:platform', requireAuth, async (req, res) => {
    const platform = String(req.params.platform || '').toLowerCase()
    const wantsJson = req.query?.json === '1' || /application\/json/i.test(String(req.headers?.accept || ''))

    if (!isAllowed(platform)) {
      return wantsJson ? res.status(400).json({ error: 'invalid_platform' }) : redirectToProfile(res, platform, 'invalid_platform')
    }
    if (!JWT_SECRET) {
      return wantsJson ? res.status(500).json({ error: 'server_not_configured' }) : redirectToProfile(res, platform, 'server_not_configured')
    }

    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'unauthorized' })

    const callbackPath = getCallbackPath(platform)
    const redirectUri = `${resolveApiBase(req)}${callbackPath}`

    let state = ''
    let opts = null
    if (platform === 'vk') {
      // VK ID (OAuth 2.1 + PKCE): state must be random (no dots), and code_verifier must be stored server-side.
      state = base64url(crypto.randomBytes(24)) // >= 32 chars
      const codeVerifier = makeVkIdCodeVerifier()
      const codeChallenge = sha256Base64url(codeVerifier)
      const storePath = path.join(String(req.app?.locals?.dataDir || process.cwd()), 'vkidConnectStates.json')
      const store = normalizeStateStore(await readJson(storePath, {}))
      const nowMs = Date.now()
      store[state] = { userId: String(userId), codeVerifier, createdAtMs: nowMs }
      // Prune expired
      for (const [k, v] of Object.entries(store)) {
        const t = typeof v?.createdAtMs === 'number' ? v.createdAtMs : 0
        if (!t || nowMs - t > VKID_STATE_TTL_MS) delete store[k]
      }
      await writeJson(storePath, store)
      opts = { codeChallenge }
    } else {
      state = jwt.sign(
        { sub: userId, platform, purpose: 'connect' },
        JWT_SECRET,
        { expiresIn: CONNECT_STATE_EXPIRY },
      )
    }

    const result = await getConnectAuthUrl(platform, state, redirectUri, opts)
    if (!result.configured || !result.authUrl) {
      return wantsJson
        ? res.status(400).json({ error: result.error || 'not_configured' })
        : redirectToProfile(res, platform, result.error || 'not_configured')
    }

    if (wantsJson) {
      return res.json({ redirectUrl: result.authUrl })
    }
    res.redirect(302, result.authUrl)
  })

  // GET /api/auth/connect/:platform/callback — exchange code, save user.socials[platform], redirect to front
  router.get('/api/auth/connect/:platform/callback', async (req, res) => {
    const platform = String(req.params.platform || '').toLowerCase()
    if (!isAllowed(platform)) {
      return redirectToProfile(res, platform, 'invalid_platform')
    }

    let stateRaw = ''
    let code = ''
    let deviceId = ''
    let userId = null
    let vkCodeVerifier = ''

    if (platform === 'vk') {
      const p = extractVkIdCallbackParams(req)
      stateRaw = String(p.state || '').trim()
      code = String(p.code || '').trim()
      deviceId = String(p.deviceId || '').trim()
      if (!stateRaw) return redirectToProfile(res, platform, 'missing_state')
      if (!code) return redirectToProfile(res, platform, 'missing_code')
      if (!deviceId) return redirectToProfile(res, platform, 'missing_device_id')

      const storePath = path.join(String(req.app?.locals?.dataDir || process.cwd()), 'vkidConnectStates.json')
      const store = normalizeStateStore(await readJson(storePath, {}))
      const entry = store[stateRaw]
      if (!entry || typeof entry !== 'object') return redirectToProfile(res, platform, 'invalid_state')
      const createdAtMs = typeof entry.createdAtMs === 'number' ? entry.createdAtMs : 0
      if (!createdAtMs || Date.now() - createdAtMs > VKID_STATE_TTL_MS) {
        delete store[stateRaw]
        await writeJson(storePath, store)
        return redirectToProfile(res, platform, 'state_expired')
      }
      userId = typeof entry.userId === 'string' ? entry.userId : null
      vkCodeVerifier = typeof entry.codeVerifier === 'string' ? entry.codeVerifier : ''
      // One-time use
      delete store[stateRaw]
      await writeJson(storePath, store)
      if (!userId || !vkCodeVerifier) return redirectToProfile(res, platform, 'invalid_state')
    } else {
      stateRaw = String(req.query?.state || '').trim()
      code = String(req.query?.code || '').trim()
      if (!stateRaw) return redirectToProfile(res, platform, 'missing_state')

      let payload
      try {
        payload = jwt.verify(stateRaw, JWT_SECRET)
      } catch {
        return redirectToProfile(res, platform, 'invalid_state')
      }
      if (payload?.purpose !== 'connect' || payload?.platform !== platform) {
        return redirectToProfile(res, platform, 'invalid_state')
      }
      userId = payload?.sub
      if (!userId) return redirectToProfile(res, platform, 'invalid_state')
    }

    const callbackPath = getCallbackPath(platform)
    const redirectUri = `${resolveApiBase(req)}${callbackPath}`

    const exchangeResult =
      platform === 'vk'
        ? await exchangeConnectCode(platform, code, redirectUri, { deviceId, codeVerifier: vkCodeVerifier, state: stateRaw })
        : await exchangeConnectCode(platform, code, redirectUri)
    if (!exchangeResult.ok || !exchangeResult.profile) {
      return redirectToProfile(res, platform, exchangeResult.error || 'exchange_failed')
    }

    const conn = await connectMongo()
    if (!conn?.enabled || mongoose.connection.readyState !== 1) {
      return redirectToProfile(res, platform, 'mongo_not_available')
    }
    const db = mongoose.connection.db
    if (!db) return redirectToProfile(res, platform, 'mongo_not_available')

    let oid
    try {
      oid = new mongoose.Types.ObjectId(userId)
    } catch {
      return redirectToProfile(res, platform, 'invalid_user')
    }

    const users = db.collection('users')
    const user = await users.findOne({ _id: oid }, { projection: { socials: 1 }, readPreference: 'primary' })
    if (!user) return redirectToProfile(res, platform, 'user_not_found')

    const socials = user.socials && typeof user.socials === 'object' && !Array.isArray(user.socials)
      ? { ...user.socials }
      : {}
    socials[platform] = exchangeResult.profile

    await users.updateOne(
      { _id: oid },
      { $set: { socials, updatedAt: new Date() } },
    )

    redirectToProfile(res, platform, null)
  })

  return router
}

function redirectToProfile(res, platform, error) {
  const base = `${trimSlash(FRONT_BASE)}/profile/edit`
  const params = new URLSearchParams()
  if (platform) params.set('connected', platform)
  if (error) params.set('error', error)
  const qs = params.toString()
  const url = qs ? `${base}?${qs}` : base
  res.redirect(302, url)
}
