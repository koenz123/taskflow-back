import path from 'node:path'
import mongoose from 'mongoose'
import { sendTelegramNotification } from '../integrations/telegramBot.js'

function defaultDataDir() {
  // Server runs from repo root (/app in docker), data dir is ./data (mounted volume in prod).
  return path.resolve(process.cwd(), 'data')
}

async function resolveTelegramUserIdForRecipient(db, recipientUserId) {
  const raw = String(recipientUserId || '').trim()
  if (!raw) return ''

  const m = raw.match(/^tg_(\d+)$/)
  if (m) return m[1]

  let oid = null
  try {
    oid = new mongoose.Types.ObjectId(raw)
  } catch {
    oid = null
  }
  if (!oid) return ''

  const u = await db.collection('users').findOne({ _id: oid }, { projection: { telegramUserId: 1 } })
  return typeof u?.telegramUserId === 'string' && u.telegramUserId ? u.telegramUserId : ''
}

export async function createNotification({ db, userId, text, meta = null, dataDir = null }) {
  if (!db) throw new Error('mongo_not_available')
  const recipientId = String(userId || '').trim()
  const message = String(text || '').trim()
  if (!recipientId || !message) return { ok: false, error: 'bad_payload' }

  const col = db.collection('notifications')
  const now = new Date()
  const insertRes = await col.insertOne({
    userId: recipientId,
    text: message,
    meta: meta && typeof meta === 'object' ? meta : null,
    createdAt: now,
  })

  let telegram = null
  try {
    const tgUserId = await resolveTelegramUserIdForRecipient(db, recipientId)
    if (tgUserId) {
      telegram = await sendTelegramNotification({ dataDir: dataDir || defaultDataDir(), telegramUserId: tgUserId, text: message })
    } else {
      telegram = { ok: false, error: 'not_telegram_user' }
    }
  } catch (e) {
    telegram = { ok: false, error: 'send_failed' }
  }

  return { ok: true, id: String(insertRes.insertedId), telegram }
}

