/**
 * OAuth (or platform-specific) adapters for "Connect social" flow.
 * Each platform: getAuthUrl(platform, state, redirectUri) and exchangeCode(platform, code, redirectUri).
 * Returns { configured, authUrl } or { configured, error, profile: { url?, username?, id? } }.
 */

const ALLOWED_PLATFORMS = ['instagram', 'tiktok', 'youtube', 'telegram', 'whatsapp', 'vk']

function isAllowed(platform) {
  return typeof platform === 'string' && ALLOWED_PLATFORMS.includes(platform.toLowerCase())
}

/**
 * Build redirect_uri for callback (must match what we register with each provider).
 */
export function getCallbackPath(platform) {
  if (!isAllowed(platform)) return null
  return `/api/auth/connect/${platform.toLowerCase()}/callback`
}

/**
 * @returns { Promise<{ configured: boolean, authUrl?: string, error?: string }> }
 */
export async function getConnectAuthUrl(platform, state, redirectUri) {
  const p = String(platform || '').toLowerCase()
  if (!isAllowed(p)) return { configured: false, error: 'invalid_platform' }

  if (p === 'vk') {
    const clientId = process.env.VK_CLIENT_ID || ''
    if (!clientId.trim()) return { configured: false, error: 'not_configured' }
    const scope = process.env.VK_CONNECT_SCOPE || 'offline'
    const v = process.env.VK_API_VERSION || '5.199'
    const authUrl = new URL('https://oauth.vk.com/authorize')
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', scope)
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('v', v)
    return { configured: true, authUrl: authUrl.toString() }
  }

  // Instagram, TikTok, YouTube, Telegram, WhatsApp: require explicit env to be configured later
  let clientId = ''
  if (p === 'tiktok') {
    // TikTok uses "Client Key" naming in its portal; support both *_CLIENT_KEY and *_CLIENT_ID for compatibility.
    clientId = process.env.TIKTOK_CLIENT_KEY || process.env.TIKTOK_CLIENT_ID || ''
  } else if (p === 'youtube') {
    // YouTube connect: use dedicated credentials only.
    clientId = process.env.YOUTUBE_CLIENT_ID || ''
  } else {
    const envKey = `${p.toUpperCase().replace(/-/g, '_')}_CLIENT_ID`
    clientId = process.env[envKey] || ''
  }
  if (!String(clientId || '').trim()) return { configured: false, error: 'not_configured' }

  if (p === 'instagram') {
    const authUrl = new URL('https://api.instagram.com/oauth/authorize')
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', 'user_profile,user_media')
    authUrl.searchParams.set('state', state)
    return { configured: true, authUrl: authUrl.toString() }
  }

  if (p === 'youtube') {
    const csrfState = state
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/youtube.readonly')
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('state', csrfState)
    // Keep consent prompt to ensure refresh_token is returned reliably.
    authUrl.searchParams.set('prompt', 'consent')
    return { configured: true, authUrl: authUrl.toString() }
  }

  if (p === 'tiktok') {
    const csrfState = state
    const authUrl = new URL('https://www.tiktok.com/v2/auth/authorize/')
    authUrl.searchParams.set('client_key', clientId)
    authUrl.searchParams.set('scope', 'user.info.basic')
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('state', csrfState)
    return { configured: true, authUrl: authUrl.toString() }
  }

  // Telegram: no standard OAuth redirect; WhatsApp: Business API differs. Stub.
  return { configured: false, error: 'not_configured' }
}

/**
 * Exchange code for token and fetch profile. Save-friendly shape: { url?, username?, id? }.
 * @returns { Promise<{ configured: boolean, ok: boolean, profile?: { url?: string, username?: string, id?: string }, error?: string }> }
 */
export async function exchangeConnectCode(platform, code, redirectUri) {
  const p = String(platform || '').toLowerCase()
  if (!isAllowed(p)) return { configured: false, ok: false, error: 'invalid_platform' }
  const c = String(code || '').trim()
  if (!c) return { configured: true, ok: false, error: 'missing_code' }

  if (p === 'vk') {
    const clientId = process.env.VK_CLIENT_ID || ''
    const clientSecret = process.env.VK_CLIENT_SECRET || ''
    if (!clientId || !clientSecret) return { configured: false, ok: false, error: 'not_configured' }
    const tokenUrl = new URL('https://oauth.vk.com/access_token')
    tokenUrl.searchParams.set('client_id', clientId)
    tokenUrl.searchParams.set('client_secret', clientSecret)
    tokenUrl.searchParams.set('redirect_uri', redirectUri)
    tokenUrl.searchParams.set('code', c)
    let resp
    try {
      resp = await fetch(tokenUrl.toString())
      const data = await resp.json()
      if (data.error) return { configured: true, ok: false, error: data.error_description || data.error }
      const userId = data.user_id != null ? String(data.user_id) : ''
      const url = userId ? `https://vk.com/id${userId}` : undefined
      return { configured: true, ok: true, profile: { id: userId || undefined, url } }
    } catch (e) {
      return { configured: true, ok: false, error: e instanceof Error ? e.message : 'request_failed' }
    }
  }

  if (p === 'instagram') {
    const clientId = process.env.INSTAGRAM_CLIENT_ID || ''
    const clientSecret = process.env.INSTAGRAM_CLIENT_SECRET || ''
    if (!clientId || !clientSecret) return { configured: false, ok: false, error: 'not_configured' }
    try {
      const tokenResp = await fetch('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code: c,
        }),
      })
      const tokenData = await tokenResp.json()
      if (tokenData.error_type || tokenData.error_message)
        return { configured: true, ok: false, error: tokenData.error_message || tokenData.error_type }
      const userId = tokenData.user_id ? String(tokenData.user_id) : ''
      const url = userId ? `https://instagram.com/${userId}` : undefined
      return { configured: true, ok: true, profile: { id: userId || undefined, url } }
    } catch (e) {
      return { configured: true, ok: false, error: e instanceof Error ? e.message : 'request_failed' }
    }
  }

  if (p === 'youtube') {
    const clientId = process.env.YOUTUBE_CLIENT_ID || ''
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET || ''
    if (!clientId || !clientSecret) return { configured: false, ok: false, error: 'not_configured' }
    try {
      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code: c,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }),
      })
      const tokenData = await tokenResp.json()
      if (tokenData.error) return { configured: true, ok: false, error: tokenData.error_description || tokenData.error }
      const accessToken = tokenData.access_token
      if (!accessToken) return { configured: true, ok: false, error: 'missing_access_token' }

      const profileResp = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      const profileData = await profileResp.json()
      if (profileData?.error) {
        const message = profileData.error?.message || 'profile_fetch_failed'
        return { configured: true, ok: false, error: message }
      }
      const channel = profileData?.items?.[0] || null
      const channelId = channel?.id ? String(channel.id) : ''
      if (!channelId) return { configured: true, ok: false, error: 'missing_channel_id' }
      const url = `https://youtube.com/channel/${channelId}`
      return { configured: true, ok: true, profile: { id: channelId, url } }
    } catch (e) {
      return { configured: true, ok: false, error: e instanceof Error ? e.message : 'request_failed' }
    }
  }

  if (p === 'tiktok') {
    const clientKey = process.env.TIKTOK_CLIENT_KEY || process.env.TIKTOK_CLIENT_ID || ''
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET || ''
    if (!clientKey || !clientSecret) return { configured: false, ok: false, error: 'not_configured' }
    try {
      const tokenResp = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_key: clientKey,
          client_secret: clientSecret,
          code: c,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }),
      })
      const tokenData = await tokenResp.json()
      if (tokenData.error) return { configured: true, ok: false, error: tokenData.error_description || tokenData.error }
      const openId = tokenData.data?.open_id ? String(tokenData.data.open_id) : ''
      return { configured: true, ok: true, profile: { id: openId || undefined } }
    } catch (e) {
      return { configured: true, ok: false, error: e instanceof Error ? e.message : 'request_failed' }
    }
  }

  return { configured: false, ok: false, error: 'not_configured' }
}

export { ALLOWED_PLATFORMS, isAllowed }
