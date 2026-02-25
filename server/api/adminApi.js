import crypto from 'node:crypto'
import express from 'express'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import mongoose from 'mongoose'
import { connectMongo } from '../infra/db.js'

function b64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, k) => {
      if (err) return reject(err)
      resolve(k)
    })
  })
  return `scrypt$${b64(salt)}$${b64(key)}`
}

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase()
}

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

  // Create or update arbiter user (email + password, role arbiter). For nativki.ru arbiter login.
  // Protected by x-admin-token === ADMIN_TOKEN. Body: { email, password }.
  router.post('/api/admin/create-arbiter', async (req, res) => {
    const adminToken = process.env.ADMIN_TOKEN || ''
    const provided = typeof req.headers['x-admin-token'] === 'string' ? req.headers['x-admin-token'].trim() : ''
    if (!adminToken || provided !== adminToken) return res.status(401).json({ error: 'unauthorized' })

    const email = normalizeEmail(req.body?.email)
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' })
    if (password.length < 6 || password.length > 200) return res.status(400).json({ error: 'invalid_password' })

    const conn = await connectMongo()
    if (!conn?.enabled || mongoose.connection.readyState !== 1) {
      return res.status(500).json({ error: 'mongo_not_available' })
    }
    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_db_missing' })
    const users = db.collection('users')

    const passwordHash = await hashPassword(password)
    const now = new Date()

    const existing = await users.findOne({ email }, { readPreference: 'primary' })
    if (existing) {
      await users.updateOne(
        { email },
        { $set: { role: 'arbiter', passwordHash, fullName: existing.fullName || 'Arbiter', updatedAt: now } },
      )
      const fresh = await users.findOne({ email }, { readPreference: 'primary' })
      return res.json({ ok: true, userId: String(fresh._id), email: fresh.email, role: 'arbiter', updated: true })
    }

    const insertRes = await users.insertOne({
      email,
      emailVerified: true,
      role: 'arbiter',
      fullName: 'Arbiter',
      phone: '',
      passwordHash,
      createdAt: now,
      updatedAt: now,
    })
    const fresh = await users.findOne({ _id: insertRes.insertedId }, { readPreference: 'primary' })
    return res.status(201).json({ ok: true, userId: String(fresh._id), email: fresh.email, role: 'arbiter' })
  })

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
      const m = userId.match(/^tg_(\d+)$/)
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

  // 🔴 Удаляет ВСЕ задания и связанные данные (приложения, контракты, споры, сообщения споров, назначения, сдачи, эскроу).
  router.delete('/api/admin/clear-all-tasks', async (req, res) => {
    const adminToken = process.env.ADMIN_TOKEN || ''
    const provided = typeof req.headers['x-admin-token'] === 'string' ? req.headers['x-admin-token'].trim() : ''
    if (!adminToken || provided !== adminToken) return res.status(401).json({ error: 'unauthorized' })

    try {
      const conn = await connectMongo()
      if (!conn?.enabled || mongoose.connection.readyState !== 1) {
        return res.status(500).json({ error: 'mongo_not_available' })
      }
      const db = mongoose.connection.db
      if (!db) return res.status(500).json({ error: 'mongo_db_missing' })

      const tasks = db.collection('tasks')
      const contracts = db.collection('contracts')
      const disputes = db.collection('disputes')
      const disputeMessages = db.collection('disputeMessages')
      const applications = db.collection('applications')
      const assignments = db.collection('assignments')
      const submissions = db.collection('submissions')
      const escrows = db.collection('escrows')

      const taskList = await tasks.find({}, { projection: { _id: 1 } }).toArray()
      const taskIds = taskList.map((t) => String(t._id))
      const contractList = await contracts.find({ taskId: { $in: taskIds } }, { projection: { _id: 1 } }).toArray()
      const contractIds = contractList.map((c) => String(c._id))
      const disputeList = await disputes.find({ contractId: { $in: contractIds } }, { projection: { _id: 1 } }).toArray()
      const disputeIds = disputeList.map((d) => String(d._id))

      let r
      r = await disputeMessages.deleteMany({ disputeId: { $in: disputeIds } })
      const deletedDisputeMessages = r.deletedCount ?? 0
      r = await disputes.deleteMany({ contractId: { $in: contractIds } })
      const deletedDisputes = r.deletedCount ?? 0
      r = await submissions.deleteMany({ contractId: { $in: contractIds } })
      const deletedSubmissions = r.deletedCount ?? 0
      r = await applications.deleteMany({ taskId: { $in: taskIds } })
      const deletedApplications = r.deletedCount ?? 0
      r = await assignments.deleteMany({ taskId: { $in: taskIds } })
      const deletedAssignments = r.deletedCount ?? 0
      r = await contracts.deleteMany({ taskId: { $in: taskIds } })
      const deletedContracts = r.deletedCount ?? 0
      r = await escrows.deleteMany({ taskId: { $in: taskIds } })
      const deletedEscrows = r.deletedCount ?? 0
      r = await tasks.deleteMany({})
      const deletedTasks = r.deletedCount ?? 0

      return res.json({
        ok: true,
        deletedTasks,
        deletedApplications,
        deletedContracts,
        deletedDisputes,
        deletedDisputeMessages,
        deletedAssignments,
        deletedSubmissions,
        deletedEscrows,
      })
    } catch (err) {
      console.error('ADMIN CLEAR TASKS ERROR:', err)
      return res.status(500).json({ error: 'failed_to_clear_tasks' })
    }
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

