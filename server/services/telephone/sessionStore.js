/**
 * In-memory store for dialog history by CallAPIID.
 * TTL 1 hour; suitable for single instance. For scaling use Redis.
 */

const TTL_MS = 60 * 60 * 1000 // 1 hour
const MAX_MESSAGES = 20

const store = new Map()

function prune() {
  const now = Date.now()
  for (const [key, entry] of store.entries()) {
    if (entry.updatedAt + TTL_MS < now) store.delete(key)
  }
}

setInterval(prune, 10 * 60 * 1000)

/**
 * @param {string} callApiId
 * @returns {{ role: 'user' | 'assistant'; content: string }[]}
 */
export function getHistory(callApiId) {
  const entry = store.get(callApiId)
  if (!entry) return []
  if (entry.updatedAt + TTL_MS < Date.now()) {
    store.delete(callApiId)
    return []
  }
  return [...entry.messages]
}

/**
 * @param {string} callApiId
 * @param {'user' | 'assistant'} role
 * @param {string} content
 */
export function appendTurn(callApiId, role, content) {
  const now = Date.now()
  let entry = store.get(callApiId)
  if (!entry) {
    entry = { messages: [], updatedAt: now }
    store.set(callApiId, entry)
  }
  entry.messages.push({ role, content })
  entry.updatedAt = now
  if (entry.messages.length > MAX_MESSAGES) {
    entry.messages = entry.messages.slice(-MAX_MESSAGES)
  }
}
