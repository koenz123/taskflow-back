import express from 'express'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import mongoose from 'mongoose'
import { connectMongo } from '../infra/db.js'

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

export function createAdminApi({ dataDir }) {
  const router = express.Router()
  router.use(express.json())

  // Promote a user to arbiter (for dispute workflow).
  // Protected by x-admin-token === ADMIN_TOKEN.
  router.post('/api/admin/promote-arbiter', async (req, res) => {
    const adminToken = process.env.ADMIN_TOKEN || ''
    const provided = typeof req.headers['x-admin-token'] === 'string' ? req.headers['x-admin-token'].trim() : ''
    if (!adminToken || provided !== adminToken) return res.status(401).json({ error: 'unauthorized' })

    const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''
    if (!userId) return res.status(400).json({ error: 'missing_userId' })

    const conn = await connectMongo()
    if (!conn?.enabled || mongoose.connection.readyState !== 1) {
      return res.status(500).json({ error: 'mongo_not_available' })
    }
    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_db_missing' })
    const users = db.collection('users')

    const query = (() => {
      const m = userId.match(/^tg_(\\d+)$/)
      if (m) return { telegramUserId: m[1] }
      try {
        return { _id: new mongoose.Types.ObjectId(userId) }
      } catch {
        return null
      }
    })()
    if (!query) return res.status(400).json({ error: 'bad_userId' })

    const existing = await users.findOne(query, { readPreference: 'primary' })
    if (!existing) return res.status(404).json({ error: 'user_not_found' })

    await users.updateOne(query, { $set: { role: 'arbiter', updatedAt: new Date() } })
    const fresh = await users.findOne(query, { readPreference: 'primary' })
    return res.json({ ok: true, userId, role: fresh?.role ?? 'arbiter' })
  })

  // 🔴 Удаляет ВСЕ Telegram аккаунты
  router.delete('/api/admin/delete-telegram-users', async (req, res) => {
    try {
      const USERS_FILE = path.join(dataDir, 'users.json')
      const LINKS_FILE = path.join(dataDir, 'telegramLinks.json')

      const users = await readJson(USERS_FILE, { byId: {}, byTelegramId: {} })
      const links = await readJson(LINKS_FILE, { byTelegramUserId: {} })

      let deletedUsers = 0
      let deletedLinks = 0

      // --- удалить TG пользователей
      for (const [id, user] of Object.entries(users.byId)) {
        if (user.telegramUserId) {
          delete users.byId[id]
          deletedUsers++
        }
      }

      // --- очистить индекс TG
      users.byTelegramId = {}

      // --- удалить TG линковки
      deletedLinks = Object.keys(links.byTelegramUserId || {}).length
      links.byTelegramUserId = {}

      await writeJson(USERS_FILE, users)
      await writeJson(LINKS_FILE, links)

      return res.json({
        ok: true,
        deletedUsers,
        deletedLinks,
      })
    } catch (err) {
      console.error('ADMIN DELETE ERROR:', err)
      return res.status(500).json({ error: 'failed_to_delete_telegram_users' })
    }
  })

  return router
}

