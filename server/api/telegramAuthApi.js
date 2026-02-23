import crypto from 'node:crypto'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import express from 'express'
import jwt from 'jsonwebtoken'

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'))
  } catch {
    return fallback
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

// Проверка подписи Telegram Login Widget.
// Алгоритм: https://core.telegram.org/widgets/login#checking-authorization
function checkTelegramAuth(data, botToken) {
  const { hash, ...rest } = data ?? {}
  if (typeof hash !== 'string' || !hash) return false

  const dataCheckString = Object.keys(rest)
    .filter((k) => rest[k] !== undefined && rest[k] !== null)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('\n')

  const secretKey = crypto.createHash('sha256').update(botToken).digest() // bytes
  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

  // Constant-time compare
  try {
    const a = Buffer.from(hmac, 'hex')
    const b = Buffer.from(hash, 'hex')
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function createTelegramAuthApi({ dataDir }) {
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  const USERS_FILE = path.join(dataDir, 'users.json')

  router.post('/api/auth/telegram/login', async (req, res) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN
    const jwtSecret = process.env.JWT_SECRET
    if (!botToken || !jwtSecret) return res.status(500).json({ error: 'server_not_configured' })

    const payload = req.body || {}

    // Ожидаем поля виджета: id, first_name, last_name, username, photo_url, auth_date, hash
    if (!payload.id || !payload.hash || !payload.auth_date) {
      return res.status(400).json({ error: 'bad_payload' })
    }

    const ok = checkTelegramAuth(payload, botToken)
    if (!ok) return res.status(401).json({ error: 'invalid_signature' })

    // (опционально) защита от “старого логина”: auth_date не старше 1 дня
    const authDateSec = Number(payload.auth_date)
    if (!Number.isFinite(authDateSec)) return res.status(400).json({ error: 'bad_auth_date' })
    const ageSec = Math.floor(Date.now() / 1000) - authDateSec
    if (ageSec > 86400) return res.status(401).json({ error: 'auth_too_old' })

    await fs.mkdir(dataDir, { recursive: true })
    const users = await readJson(USERS_FILE, { byId: {}, byTelegramId: {} })

    const telegramId = String(payload.id)
    let userId = users.byTelegramId[telegramId]
    if (!userId) {
      userId = crypto.randomUUID()
      users.byTelegramId[telegramId] = userId
      users.byId[userId] = {
        id: userId,
        telegramUserId: telegramId,
        username: payload.username || null,
        fullName: [payload.first_name, payload.last_name].filter(Boolean).join(' ').trim() || null,
        photoUrl: payload.photo_url || null,
        createdAt: new Date().toISOString(),
      }
      await writeJson(USERS_FILE, users)
    } else {
      // можно обновлять имя/аватар
      const u = users.byId[userId]
      if (u && typeof u === 'object') {
        const next = {
          ...u,
          username: payload.username || u.username || null,
          fullName: [payload.first_name, payload.last_name].filter(Boolean).join(' ').trim() || u.fullName || null,
          photoUrl: payload.photo_url || u.photoUrl || null,
          updatedAt: new Date().toISOString(),
        }
        users.byId[userId] = next
        await writeJson(USERS_FILE, users)
      }
    }

    const token = jwt.sign({ sub: userId, tg: telegramId }, jwtSecret, { expiresIn: '30d' })

    res.json({
      token,
      user: users.byId[userId],
    })
  })

  return router
}

