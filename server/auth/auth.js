import { tryResolveAuthUser } from './authSession.js'

// Optional auth: never 401, just attaches req.user or null.
export async function optionalAuth(req, _res, next) {
  try {
    const r = await tryResolveAuthUser(req)
    req.user = r.ok ? { id: r.userId } : null
    req._authError = r.ok ? null : r.error
  } catch (e) {
    req.user = null
    req._authError = 'unauthorized'
  }
  next()
}

export async function requireAuth(req, res, next) {
  try {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    req.user = { id: r.userId }
    return next()
  } catch (e) {
    req.log?.warn?.('Unauthorized request', { reason: 'auth_error', error: e instanceof Error ? e.message : String(e) })
    return res.status(401).json({ error: 'unauthorized' })
  }
}

