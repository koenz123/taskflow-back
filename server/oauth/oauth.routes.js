import express from 'express'
import jwt from 'jsonwebtoken'
import { requireAuth } from '../auth/auth.js'
import config from './oauth.config.js'
import { exchangeCode, profileFromTokenData, saveToUser } from './oauth.service.js'

const router = express.Router()
const JWT_SECRET = process.env.JWT_SECRET || ''
const FRONT_URL = (process.env.FRONT_URL || process.env.FRONTEND_BASE_URL || 'http://localhost:5173').replace(/\/+$/, '')

/** GET /api/oauth/:provider/start — redirect to provider's authorize page (requires auth). */
router.get('/:provider/start', requireAuth, async (req, res, next) => {
  try {
    const { provider } = req.params
    const cfg = config[provider]
    if (!cfg) return res.status(400).send('Unsupported provider')
    if (!cfg.clientId) return res.status(502).redirect(`${FRONT_URL}/profile/edit?error=not_configured`)

    const userId = req.user?.id ?? null
    if (!userId) return res.status(401).json({ error: 'unauthorized' })
    const state = jwt.sign({ userId, provider, purpose: 'oauth', time: Date.now() }, JWT_SECRET, { expiresIn: '10m' })

    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      scope: cfg.scope,
      state,
    })
    const url = `${cfg.authorizeUrl}?${params.toString()}`
    res.redirect(302, url)
  } catch (e) {
    next(e)
  }
})

/** GET /api/oauth/:provider/callback — exchange code for token, save to user, redirect to front. */
router.get('/:provider/callback', async (req, res, next) => {
  try {
    const { provider } = req.params
    const { code, state: stateRaw } = req.query

    const cfg = config[provider]
    if (!cfg) return res.redirect(`${FRONT_URL}/profile/edit?error=invalid_provider`)
    if (!code) return res.redirect(`${FRONT_URL}/profile/edit?error=no_code`)

    let userId = null
    if (stateRaw && JWT_SECRET) {
      try {
        const payload = jwt.verify(String(stateRaw), JWT_SECRET)
        if (payload?.purpose === 'oauth' && payload?.provider === provider) userId = payload.userId
      } catch {
        // ignore
      }
    }
    if (!userId && stateRaw) {
      try {
        const decoded = JSON.parse(Buffer.from(String(stateRaw), 'base64').toString('utf8'))
        userId = decoded.userId
      } catch {
        // ignore
      }
    }

    const result = await exchangeCode(provider, code, cfg)
    if (!result.ok) {
      console.error('[oauth] exchange failed', { provider, error: result.error })
      return res.redirect(`${FRONT_URL}/profile/edit?error=${encodeURIComponent(result.error || 'exchange_failed')}`)
    }

    const profile = profileFromTokenData(provider, result.data)
    if (userId && userId !== 'test-user') {
      const save = await saveToUser(userId, provider, profile)
      if (!save.ok) console.error('[oauth] save failed', { provider, userId, error: save.error })
    } else {
      console.log('[oauth] token (no user to save):', { provider, keys: Object.keys(result.data || {}) })
    }

    res.redirect(302, `${FRONT_URL}/profile/edit?connected=${provider}`)
  } catch (err) {
    console.error('[oauth] callback error', err?.response?.data || err?.message || err)
    res.redirect(`${FRONT_URL}/profile/edit?error=callback_error`)
  }
})

export default router
