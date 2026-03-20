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
export async function getConnectAuthUrl(platform, state, redirectUri, opts = null) {
  const p = String(platform || '').toLowerCase()
  if (!isAllowed(p)) return { configured: false, error: 'invalid_platform' }

  if (p === 'vk') {
    const clientId = process.env.VK_CLIENT_ID || ''
    if (!clientId.trim()) return { configured: false, error: 'not_configured' }
    const codeChallenge = typeof opts?.codeChallenge === 'string' ? opts.codeChallenge : ''
    if (!codeChallenge) return { configured: false, error: 'missing_pkce' }
    // VK ID (OAuth 2.1 + PKCE). Docs: https://id.vk.com/.../auth-without-sdk-web
    const scope = typeof process.env.VKID_SCOPE === 'string' && process.env.VKID_SCOPE.trim()
      ? process.env.VKID_SCOPE.trim()
      : 'email phone'
    const authUrl = new URL('https://id.vk.ru/authorize')
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('scope', scope)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('code_challenge', codeChallenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    return { configured: true, authUrl: authUrl.toString() }
  }

  // Instagram, TikTok, YouTube, Telegram, WhatsApp: require explicit env to be configured later
  let clientId = ''
  if (p === 'tiktok') {
    // TikTok Login Kit uses Client Key only (not client_id).
    clientId = process.env.TIKTOK_CLIENT_KEY || ''
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
    authUrl.searchParams.set('client_key', process.env.TIKTOK_CLIENT_KEY || '')
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
 * @returns { Promise<{ configured: boolean, ok: boolean, profile?: object, error?: string }> }
 */
export async function exchangeConnectCode(platform, code, redirectUri, opts = null) {
  const p = String(platform || '').toLowerCase()
  if (!isAllowed(p)) return { configured: false, ok: false, error: 'invalid_platform' }
  const c = String(code || '').trim()
  if (!c) return { configured: true, ok: false, error: 'missing_code' }

  if (p === 'vk') {
    const clientId = process.env.VK_CLIENT_ID || ''
    if (!clientId) return { configured: false, ok: false, error: 'not_configured' }
    const deviceId = typeof opts?.deviceId === 'string' ? opts.deviceId.trim() : ''
    const codeVerifier = typeof opts?.codeVerifier === 'string' ? opts.codeVerifier.trim() : ''
    const state = typeof opts?.state === 'string' ? opts.state.trim() : ''
    if (!deviceId) return { configured: true, ok: false, error: 'missing_device_id' }
    if (!codeVerifier) return { configured: true, ok: false, error: 'missing_code_verifier' }
    if (!state) return { configured: true, ok: false, error: 'missing_state' }

    try {
      // VK ID token exchange (OAuth 2.1 + PKCE)
      const tokenResp = await fetch('https://id.vk.ru/oauth2/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
          code: c,
          client_id: clientId,
          device_id: deviceId,
          state,
        }),
      })
      const tokenData = await tokenResp.json()
      if (tokenData?.error) {
        return { configured: true, ok: false, error: tokenData.error_description || tokenData.error }
      }
      const accessToken = typeof tokenData?.access_token === 'string' ? tokenData.access_token : ''
      const vkUserId = tokenData?.user_id != null ? String(tokenData.user_id) : ''
      if (!accessToken || !vkUserId) return { configured: true, ok: false, error: 'vkid_bad_token_response' }

      // VK ID user info
      const infoResp = await fetch('https://id.vk.ru/oauth2/user_info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ access_token: accessToken, client_id: clientId }),
      })
      const infoData = await infoResp.json()
      const user = infoData?.user || null
      const firstName = typeof user?.first_name === 'string' ? user.first_name : undefined
      const lastName = typeof user?.last_name === 'string' ? user.last_name : undefined
      const photo = typeof user?.avatar === 'string' ? user.avatar : undefined
      const email = typeof user?.email === 'string' ? user.email : undefined

      // Best-effort: resolve pretty username/domain via VK API using VK ID access_token (if allowed).
      let username = undefined
      try {
        const apiVersion = process.env.VK_API_VERSION || '5.199'
        const userUrl = new URL('https://api.vk.com/method/users.get')
        userUrl.searchParams.set('user_ids', vkUserId)
        userUrl.searchParams.set('fields', 'domain,screen_name')
        userUrl.searchParams.set('access_token', accessToken)
        userUrl.searchParams.set('v', apiVersion)
        const vkApiResp = await fetch(userUrl.toString())
        const vkApiData = await vkApiResp.json()
        const u = Array.isArray(vkApiData?.response) ? vkApiData.response[0] : null
        const domain = typeof u?.domain === 'string' ? u.domain.trim() : ''
        const screen = typeof u?.screen_name === 'string' ? u.screen_name.trim() : ''
        username = domain || screen || undefined
      } catch {
        username = undefined
      }

      const profileUrl = username ? `https://vk.com/${username}` : `https://vk.com/id${vkUserId}`
      const now = new Date()
      return {
        configured: true,
        ok: true,
        profile: {
          connected: true,
          vkUserId,
          username,
          firstName,
          lastName,
          photo,
          email,
          accessToken,
          profileUrl,
          connectedAt: now,
        },
      }
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
    const clientKey = process.env.TIKTOK_CLIENT_KEY || ''
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
      const accessToken = tokenData.data?.access_token
      if (!accessToken) return { configured: true, ok: false, error: 'missing_access_token' }

      const profileResp = await fetch(
        'https://open.tiktokapis.com/v2/user/info/?fields=open_id,username,display_name,avatar_url',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      )
      const profileData = await profileResp.json()
      if (profileData?.error?.code !== undefined && profileData.error.code !== 0) {
        const msg = profileData.error?.message || 'user_info_failed'
        return { configured: true, ok: false, error: msg }
      }
      const user = profileData?.data?.user
      if (!user) return { configured: true, ok: false, error: 'missing_user_info' }
      const openId = user.open_id ? String(user.open_id) : ''
      const username = typeof user.username === 'string' ? user.username.trim() || undefined : undefined
      const displayName = typeof user.display_name === 'string' ? user.display_name.trim() || undefined : undefined
      const avatar = typeof user.avatar_url === 'string' ? user.avatar_url.trim() || undefined : undefined
      const url = username ? `https://www.tiktok.com/@${username}` : undefined
      return {
        configured: true,
        ok: true,
        profile: {
          id: openId || undefined,
          username,
          displayName,
          avatar,
          url,
        },
      }
    } catch (e) {
      return { configured: true, ok: false, error: e instanceof Error ? e.message : 'request_failed' }
    }
  }

  return { configured: false, ok: false, error: 'not_configured' }
}

export { ALLOWED_PLATFORMS, isAllowed }
