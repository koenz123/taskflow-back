import express from 'express'
import path from 'node:path'
import { promises as fs } from 'node:fs'

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

