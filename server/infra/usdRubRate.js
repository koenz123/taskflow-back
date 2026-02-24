import path from 'node:path'
import { promises as fs } from 'node:fs'

function safeNumber(v) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

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

export async function getUsdRubRate({ dataDir, maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  const env = safeNumber(process.env.USD_RUB_RATE)
  if (env && env > 0) return env

  const filePath = dataDir ? path.join(dataDir, 'usdRubRate.json') : null
  const cached = filePath ? await readJson(filePath, null) : null
  const cachedRate = safeNumber(cached?.rate)
  const cachedAt = typeof cached?.fetchedAt === 'string' ? Date.parse(cached.fetchedAt) : NaN
  const freshEnough = cachedRate && Number.isFinite(cachedAt) ? Date.now() - cachedAt < maxAgeMs : false
  if (freshEnough) return cachedRate

  try {
    // CBR daily rate (public, no auth).
    const resp = await fetch('https://www.cbr-xml-daily.ru/daily_json.js', { method: 'GET' })
    if (!resp.ok) throw new Error(`rate_http_${resp.status}`)
    const data = await resp.json()
    const rate = safeNumber(data?.Valute?.USD?.Value)
    if (!rate || rate <= 0) throw new Error('rate_parse_failed')
    if (filePath) {
      await writeJson(filePath, { rate, fetchedAt: new Date().toISOString(), source: 'cbr-xml-daily' })
    }
    return rate
  } catch (e) {
    if (cachedRate && cachedRate > 0) return cachedRate
    const fallback = 80 // last resort; better than crashing
    return fallback
  }
}

