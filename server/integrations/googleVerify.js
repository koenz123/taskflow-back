import { OAuth2Client } from 'google-auth-library'

let client = null

function getClient() {
  if (client) return client
  const audience = String(process.env.GOOGLE_WEB_CLIENT_ID || '').trim()
  if (!audience) return null
  client = new OAuth2Client(audience)
  return client
}

export async function verifyGoogleToken(idToken) {
  const token = String(idToken || '').trim()
  if (!token) throw new Error('missing_id_token')

  const audience = String(process.env.GOOGLE_WEB_CLIENT_ID || '').trim()
  if (!audience) throw new Error('google_client_id_missing')

  const c = getClient()
  if (!c) throw new Error('google_client_id_missing')

  const ticket = await c.verifyIdToken({ idToken: token, audience })
  const payload = ticket.getPayload()
  if (!payload) throw new Error('invalid_google_payload')
  return payload
}

