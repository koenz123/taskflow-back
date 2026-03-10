/**
 * GigaChat API client: OAuth token + chat completion.
 * @see https://developers.sber.ru/docs/ru/gigachat/api/reference/rest
 */

const AUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth'
const CHAT_URL = 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions'

/**
 * @param {{ credentials: string; model: string; scope?: string }} options
 */
export function createGigaChatClient(options) {
  const credentials = options.credentials
  const model = options.model
  const scope = options.scope ?? 'GIGACHAT_API_PERS'

  let accessToken = null
  let expiresAt = 0

  async function getAccessToken() {
    const now = Date.now()
    if (accessToken && expiresAt > now + 60_000) {
      return accessToken
    }

    const response = await fetch(AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
        RqUID: crypto.randomUUID(),
      },
      body: `scope=${encodeURIComponent(scope)}`,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`GigaChat auth failed: ${response.status} ${text}`)
    }

    const data = await response.json()
    accessToken = data.access_token
    expiresAt = data.expires_at ? data.expires_at * 1000 : now + 30 * 60 * 1000
    return accessToken
  }

  /**
   * @param {{ role: 'system' | 'user' | 'assistant'; content: string }[]} messages
   * @returns {Promise<string>}
   */
  async function chat(messages) {
    const token = await getAccessToken()

    const response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: 150,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`GigaChat chat failed: ${response.status} ${text}`)
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content?.trim()
    return content ?? ''
  }

  return { chat }
}
