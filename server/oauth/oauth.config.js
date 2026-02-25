const BASE_URL = process.env.BASE_URL || process.env.PUBLIC_BASE_URL || process.env.API_BASE_URL || 'http://localhost:4000'

export default {
  vk: {
    authorizeUrl: 'https://oauth.vk.com/authorize',
    tokenUrl: 'https://oauth.vk.com/access_token',
    clientId: process.env.VK_CLIENT_ID,
    clientSecret: process.env.VK_CLIENT_SECRET,
    scope: 'email',
    redirectUri: `${BASE_URL.replace(/\/+$/, '')}/api/oauth/vk/callback`,
  },

  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: process.env.GOOGLE_WEB_CLIENT_ID,
    clientSecret: process.env.GOOGLE_WEB_CLIENT_SECRET,
    scope: 'https://www.googleapis.com/auth/youtube.readonly',
    redirectUri: `${BASE_URL.replace(/\/+$/, '')}/api/oauth/google/callback`,
  },

  instagram: {
    authorizeUrl: 'https://api.instagram.com/oauth/authorize',
    tokenUrl: 'https://api.instagram.com/oauth/access_token',
    clientId: process.env.INSTAGRAM_CLIENT_ID,
    clientSecret: process.env.INSTAGRAM_CLIENT_SECRET,
    scope: 'user_profile,user_media',
    redirectUri: `${BASE_URL.replace(/\/+$/, '')}/api/oauth/instagram/callback`,
  },

  tiktok: {
    authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    clientId: process.env.TIKTOK_CLIENT_KEY,
    clientSecret: process.env.TIKTOK_CLIENT_SECRET,
    scope: 'user.info.basic',
    redirectUri: `${BASE_URL.replace(/\/+$/, '')}/api/oauth/tiktok/callback`,
  },
}
