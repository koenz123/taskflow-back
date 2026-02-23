import path from 'node:path'
import { promises as fs } from 'node:fs'

async function readJson(filePath, fallback) {
  try {
    const txt = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(txt)
  } catch {
    return fallback
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

function normalizeBalances(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value
}

export function createBalanceRepo({ dataDir }) {
  const BALANCES_FILE = path.join(dataDir, 'balances.json')

  async function get(userId) {
    const balances = normalizeBalances(await readJson(BALANCES_FILE, {}))
    const current = balances[userId]
    return typeof current === 'number' && Number.isFinite(current) ? current : 0
  }

  async function adjust(userId, delta) {
    const balances = normalizeBalances(await readJson(BALANCES_FILE, {}))
    const prev = typeof balances[userId] === 'number' && Number.isFinite(balances[userId]) ? balances[userId] : 0
    const next = prev + delta
    balances[userId] = next
    await writeJson(BALANCES_FILE, balances)
    return next
  }

  return { get, adjust }
}

