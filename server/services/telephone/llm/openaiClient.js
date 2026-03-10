/**
 * OpenAI (ChatGPT) API client for chat completions.
 * @see https://platform.openai.com/docs/api-reference/chat
 */

const CHAT_URL = 'https://api.openai.com/v1/chat/completions'

/**
 * @param {{ apiKey: string; model?: string }} options
 */
export function createOpenAIClient(options) {
  const apiKey = options.apiKey
  const model = options.model ?? 'gpt-4o-mini'

  /**
   * @param {{ role: 'system' | 'user' | 'assistant'; content: string }[]} messages
   * @returns {Promise<string>}
   */
  async function chat(messages) {
    const response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
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
      throw new Error(`OpenAI chat failed: ${response.status} ${text}`)
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content?.trim()
    return content ?? ''
  }

  return { chat }
}
