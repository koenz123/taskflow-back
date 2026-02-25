import mongoose from 'mongoose'

/**
 * Exchange authorization code for tokens. Provider-specific (VK uses GET, others POST form).
 * @returns { Promise<{ ok: boolean, data?: object, error?: string }> }
 */
export async function exchangeCode(provider, code, cfg) {
  if (!cfg?.clientId || !cfg?.clientSecret) {
    return { ok: false, error: 'not_configured' }
  }
  const c = String(code || '').trim()
  if (!c) return { ok: false, error: 'missing_code' }

  if (provider === 'vk') {
    const url = new URL(cfg.tokenUrl)
    url.searchParams.set('client_id', cfg.clientId)
    url.searchParams.set('client_secret', cfg.clientSecret)
    url.searchParams.set('redirect_uri', cfg.redirectUri)
    url.searchParams.set('code', c)
    try {
      const res = await fetch(url.toString())
      const data = await res.json()
      if (data.error) return { ok: false, error: data.error_description || data.error }
      return { ok: true, data }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'request_failed' }
    }
  }

  if (provider === 'tiktok') {
    const body = new URLSearchParams({
      client_key: cfg.clientId,
      client_secret: cfg.clientSecret,
      code: c,
      grant_type: 'authorization_code',
      redirect_uri: cfg.redirectUri,
    })
    try {
      const res = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
      })
      const data = await res.json()
      if (data.error) return { ok: false, error: data.error_description || data.error }
      return { ok: true, data: data.data || data }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'request_failed' }
    }
  }

  // google, instagram: POST application/x-www-form-urlencoded
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code: c,
    grant_type: 'authorization_code',
    redirect_uri: cfg.redirectUri,
  })
  try {
    const res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const data = await res.json()
    if (data.error || data.error_type || data.error_message) {
      return { ok: false, error: data.error_description || data.error_message || data.error }
    }
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'request_failed' }
  }
}

/**
 * Build profile object for user.socials[provider]. Optional: fetch profile from provider API.
 */
export function profileFromTokenData(provider, tokenData) {
  if (provider === 'vk' && tokenData?.user_id != null) {
    const id = String(tokenData.user_id)
    return { id, url: `https://vk.com/id${id}` }
  }
  if (provider === 'instagram' && tokenData?.user_id != null) {
    const id = String(tokenData.user_id)
    return { id, url: `https://instagram.com/${id}` }
  }
  if (provider === 'google' && tokenData?.access_token) {
    return { id: undefined, url: undefined }
  }
  if (provider === 'tiktok' && tokenData?.open_id) {
    return { id: String(tokenData.open_id) }
  }
  return {}
}

/**
 * Save OAuth result to user.socials[provider] in MongoDB.
 */
export async function saveToUser(userId, provider, profile) {
  const conn = await mongoose.connection?.readyState === 1 ? { enabled: true } : null
  if (!conn?.enabled) return { ok: false, error: 'mongo_not_available' }
  const db = mongoose.connection.db
  if (!db) return { ok: false, error: 'mongo_not_available' }

  let oid
  try {
    oid = new mongoose.Types.ObjectId(userId)
  } catch {
    return { ok: false, error: 'invalid_user_id' }
  }

  const users = db.collection('users')
  const user = await users.findOne({ _id: oid }, { projection: { socials: 1 }, readPreference: 'primary' })
  if (!user) return { ok: false, error: 'user_not_found' }

  const socials = user.socials && typeof user.socials === 'object' && !Array.isArray(user.socials)
    ? { ...user.socials }
    : {}
  socials[provider] = profile && typeof profile === 'object' ? profile : {}

  await users.updateOne({ _id: oid }, { $set: { socials, updatedAt: new Date() } })
  return { ok: true }
}
