/**
 * In-memory store for dialog history by CallAPIID.
 * TTL 1 hour; suitable for single instance. For scaling use Redis.
 */

const TTL_MS = 60 * 60 * 1000; // 1 hour

export interface DialogTurn {
  role: "user" | "assistant";
  content: string;
}

interface Entry {
  messages: DialogTurn[];
  updatedAt: number;
}

const store = new Map<string, Entry>();

function prune(): void {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.updatedAt + TTL_MS < now) store.delete(key);
  }
}

setInterval(prune, 10 * 60 * 1000);

export function getHistory(callApiId: string): DialogTurn[] {
  const entry = store.get(callApiId);
  if (!entry) return [];
  if (entry.updatedAt + TTL_MS < Date.now()) {
    store.delete(callApiId);
    return [];
  }
  return [...entry.messages];
}

export function appendTurn(callApiId: string, role: "user" | "assistant", content: string): void {
  const now = Date.now();
  let entry = store.get(callApiId);
  if (!entry) {
    entry = { messages: [], updatedAt: now };
    store.set(callApiId, entry);
  }
  entry.messages.push({ role, content });
  entry.updatedAt = now;

  if (entry.messages.length > 20) {
    entry.messages = entry.messages.slice(-20);
  }
}
