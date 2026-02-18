import TelegramBot from 'node-telegram-bot-api'
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

async function upsertLink({ linksFile, telegramUserId, chatId }) {
  const links = await readJson(linksFile, { byTelegramUserId: {} })
  if (!links.byTelegramUserId || typeof links.byTelegramUserId !== 'object') {
    links.byTelegramUserId = {}
  }
  links.byTelegramUserId[String(telegramUserId)] = {
    chatId,
    linkedAt: new Date().toISOString(),
  }
  await writeJson(linksFile, links)
}

async function removeLink({ linksFile, telegramUserId }) {
  const links = await readJson(linksFile, { byTelegramUserId: {} })
  if (!links.byTelegramUserId || typeof links.byTelegramUserId !== 'object') {
    links.byTelegramUserId = {}
  }
  const key = String(telegramUserId)
  const existed = Boolean(links.byTelegramUserId[key])
  if (existed) {
    delete links.byTelegramUserId[key]
    await writeJson(linksFile, links)
  }
  return existed
}

export function startTelegramBot({ dataDir }) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.warn('[tg] TELEGRAM_BOT_TOKEN not set, bot disabled')
    return null
  }

  const LINKS_FILE = path.join(dataDir, 'telegramLinks.json')
  const bot = new TelegramBot(token, { polling: true })

  // Ensure dataDir exists (so we can write telegramLinks.json).
  void fs.mkdir(dataDir, { recursive: true }).catch(() => {})

  async function linkFromMessage(msg) {
    const chatId = msg.chat?.id
    const telegramUserId = msg.from?.id
    if (!telegramUserId || !chatId) return

    await upsertLink({ linksFile: LINKS_FILE, telegramUserId, chatId })

    await bot.sendMessage(
      chatId,
      '✅ Готово! Теперь я буду присылать уведомления из TaskFlow.\n\nЕсли ты ещё не вошёл в приложении — вернись и залогинься через Telegram.',
    )
  }

  bot.onText(/^\/start(?:@[\w_]+)?(?:\s|$)/, async (msg) => {
    try {
      await linkFromMessage(msg)
    } catch (e) {
      const chatId = msg.chat?.id
      if (chatId) await bot.sendMessage(chatId, 'Не получилось привязать чат. Попробуй ещё раз чуть позже.')
    }
  })

  bot.onText(/^\/link(?:@[\w_]+)?(?:\s|$)/, async (msg) => {
    try {
      await linkFromMessage(msg)
    } catch (e) {
      const chatId = msg.chat?.id
      if (chatId) await bot.sendMessage(chatId, 'Не получилось привязать чат. Попробуй ещё раз чуть позже.')
    }
  })

  bot.onText(/^\/unlink(?:@[\w_]+)?(?:\s|$)/, async (msg) => {
    const chatId = msg.chat?.id
    const telegramUserId = msg.from?.id
    if (!telegramUserId || !chatId) return
    try {
      const existed = await removeLink({ linksFile: LINKS_FILE, telegramUserId })
      await bot.sendMessage(chatId, existed ? '🧹 Ок, отвязал. Уведомления больше не будут приходить.' : 'Нечего отвязывать 🙂')
    } catch (e) {
      await bot.sendMessage(chatId, 'Не получилось отвязать. Попробуй ещё раз чуть позже.')
    }
  })

  console.log('[tg] bot started (polling)')
  return bot
}

export async function sendTelegramNotification({ dataDir, text, telegramUserId }) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return { ok: false, error: 'bot_disabled' }

  const LINKS_FILE = path.join(dataDir, 'telegramLinks.json')
  const links = await readJson(LINKS_FILE, { byTelegramUserId: {} })
  const rec = links.byTelegramUserId?.[String(telegramUserId)] ?? null
  if (!rec?.chatId) return { ok: false, error: 'not_linked' }

  // Lightweight instance for sending via HTTP (no polling/webhook).
  const bot = new TelegramBot(token)
  await bot.sendMessage(rec.chatId, text)
  return { ok: true }
}

