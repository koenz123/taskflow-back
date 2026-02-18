import express from 'express'
import { sendTelegramNotification } from './telegramBot.js'

export function createNotifyApi({ dataDir }) {
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  router.post('/api/notify', async (req, res) => {
    // ожидаем: { telegramUserId, text }
    const telegramUserId = String(req.body?.telegramUserId || '').trim()
    const text = String(req.body?.text || '').trim()

    if (!telegramUserId || !text) return res.status(400).json({ error: 'bad_payload' })

    const result = await sendTelegramNotification({ dataDir, telegramUserId, text })
    res.json(result)
  })

  return router
}

