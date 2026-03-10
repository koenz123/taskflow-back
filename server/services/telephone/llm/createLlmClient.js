/**
 * Factory: returns LLM client (GigaChat or OpenAI) based on env, or null.
 * GigaChat has priority for the telephone flow when both keys are present.
 * @returns {Promise<{ chat: (messages: { role: string; content: string }[]) => Promise<string> } | null>}
 */
export async function createLlmClient() {
  const gigachatCredentials = (process.env.GIGACHAT_CREDENTIALS ?? '').trim()
  if (gigachatCredentials) {
    const { createGigaChatClient } = await import('./gigachatClient.js')
    return createGigaChatClient({
      credentials: gigachatCredentials,
      model: (process.env.GIGACHAT_MODEL ?? 'GigaChat-2').trim() || 'GigaChat-2',
      scope: (process.env.GIGACHAT_SCOPE ?? 'GIGACHAT_API_PERS').trim() || undefined,
    })
  }

  const openaiKey = (process.env.OPENAI_API_KEY ?? '').trim()
  if (openaiKey) {
    const { createOpenAIClient } = await import('./openaiClient.js')
    return createOpenAIClient({
      apiKey: openaiKey,
      model: (process.env.OPENAI_MODEL ?? 'gpt-4o-mini').trim() || undefined,
    })
  }

  return null
}
