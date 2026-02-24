import express from 'express'
import jwt from 'jsonwebtoken'
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

function trimSlash(s) {
  return typeof s === 'string' ? s.replace(/\/+$/, '') : ''
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

    const state = jwt.sign(
      { sub: userId, platform, purpose: 'connect' },
      JWT_SECRET,
      { expiresIn: CONNECT_STATE_EXPIRY },
    )
    const callbackPath = getCallbackPath(platform)
    const redirectUri = `${trimSlash(API_BASE)}${callbackPath}`

    const result = await getConnectAuthUrl(platform, state, redirectUri)
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

    const stateRaw = String(req.query?.state || '').trim()
    const code = String(req.query?.code || '').trim()
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
    const userId = payload?.sub
    if (!userId) return redirectToProfile(res, platform, 'invalid_state')

    const callbackPath = getCallbackPath(platform)
    const redirectUri = `${trimSlash(API_BASE)}${callbackPath}`

    const exchangeResult = await exchangeConnectCode(platform, code, redirectUri)
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
