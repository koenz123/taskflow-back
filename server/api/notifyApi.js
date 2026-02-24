import express from 'express'
import { sendTelegramNotification } from '../integrations/telegramBot.js'
import { sendNotificationEmail } from '../integrations/sendVerificationEmail.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function createNotifyApi({ dataDir }) {
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  router.post('/api/notify', async (req, res) => {
    // тело: опционально telegramUserId, опционально email; обязательно text
    const telegramUserId = String(req.body?.telegramUserId ?? '').trim()
    const email = String(req.body?.email ?? '').trim().toLowerCase()
    const text = String(req.body?.text ?? '').trim()

    if (!text) return res.status(400).json({ error: 'bad_payload' })
    if (!telegramUserId && !email) return res.status(400).json({ error: 'bad_payload' })
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' })

    const result = {}

    if (telegramUserId) {
      result.telegram = await sendTelegramNotification({ dataDir, telegramUserId, text })
    }
    if (email) {
      result.email = await sendNotificationEmail(email, text)
    }

    res.json(result)
  })

  return router
}

