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

const REMOVE_KEYBOARD = { reply_markup: { remove_keyboard: true } }

export function startTelegramBot({ dataDir, getPhoneByTelegramId = null, updateUserPhoneByTelegramId = null }) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.warn('[tg] TELEGRAM_BOT_TOKEN not set, bot disabled')
    return null
  }

  const LINKS_FILE = path.join(dataDir, 'telegramLinks.json')
  const bot = new TelegramBot(token, { polling: true })

  // Ensure dataDir exists (so we can write telegramLinks.json).
  void fs.mkdir(dataDir, { recursive: true }).catch(() => {})

  const SHARE_PHONE_KEYBOARD = {
    reply_markup: {
      keyboard: [[{ text: '📱 Поделиться номером телефона', request_contact: true }]],
      one_time_keyboard: true,
      resize_keyboard: true,
    },
  }

  async function linkFromMessage(msg) {
    const chatId = msg.chat?.id
    const telegramUserId = msg.from?.id
    if (!telegramUserId || !chatId) return null

    await upsertLink({ linksFile: LINKS_FILE, telegramUserId, chatId })
    return { chatId, telegramUserId }
  }

  async function sendStartOrLinkReply(chatId, telegramUserId) {
    const hasPhone =
      typeof getPhoneByTelegramId === 'function' &&
      (await getPhoneByTelegramId(telegramUserId))
    if (hasPhone) {
      await bot.sendMessage(
        chatId,
        '✅ Готово! Теперь я буду присылать уведомления из TaskFlow.\n\nНомер в профиле уже указан.',
        REMOVE_KEYBOARD,
      )
    } else {
      await bot.sendMessage(
        chatId,
        '✅ Готово! Теперь я буду присылать уведомления из TaskFlow.\n\nПоделитесь номером телефона — он отобразится в вашем профиле на сайте.',
        SHARE_PHONE_KEYBOARD,
      )
    }
  }

  bot.onText(/^\/start(?:@[\w_]+)?(?:\s|$)/, async (msg) => {
    const chatId = msg.chat?.id
    const telegramUserId = msg.from?.id
    if (!chatId || !telegramUserId) return
    try {
      await linkFromMessage(msg)
      await sendStartOrLinkReply(chatId, telegramUserId)
    } catch (e) {
      await bot.sendMessage(chatId, 'Не получилось привязать чат. Попробуй ещё раз чуть позже.')
    }
  })

  bot.onText(/^\/link(?:@[\w_]+)?(?:\s|$)/, async (msg) => {
    const chatId = msg.chat?.id
    const telegramUserId = msg.from?.id
    if (!chatId || !telegramUserId) return
    try {
      await linkFromMessage(msg)
      await sendStartOrLinkReply(chatId, telegramUserId)
    } catch (e) {
      await bot.sendMessage(chatId, 'Не получилось привязать чат. Попробуй ещё раз чуть позже.')
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

  bot.on('message', async (msg) => {
    const chatId = msg.chat?.id
    const telegramUserId = msg.from?.id
    const text = typeof msg.text === 'string' ? msg.text.trim() : ''
    if (!chatId) return

    if (msg.contact) {
      const contact = msg.contact
      const phone = contact.phone_number ? String(contact.phone_number).trim() : ''
      if (!phone) {
        await bot.sendMessage(chatId, 'Не удалось получить номер. Попробуйте ещё раз.')
        return
      }
      if (typeof updateUserPhoneByTelegramId === 'function') {
        try {
          const result = await updateUserPhoneByTelegramId(telegramUserId, phone)
          if (result && result.ok) {
            await bot.sendMessage(chatId, '✅ Номер сохранён в вашем профиле на сайте.', REMOVE_KEYBOARD)
            return
          }
        } catch (e) {
          console.warn('[tg] updateUserPhoneByTelegramId failed', e?.message || e)
        }
      }
      await bot.sendMessage(chatId, 'Номер не удалось сохранить в профиль. Попробуйте позже или укажите его в настройках на сайте.')
      return
    }

    if (!text) return
    if (/^\/start(?:@[\w_]+)?(?:\s|$)/.test(text)) return
    if (/^\/link(?:@[\w_]+)?(?:\s|$)/.test(text)) return
    if (/^\/unlink(?:@[\w_]+)?(?:\s|$)/.test(text)) return
    await bot.sendMessage(chatId, 'Нажмите /start чтобы вам приходили уведомления.')
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

