import express from 'express'
import { tryResolveAuthUser } from './authSession.js'
import { requireAuth } from './auth.js'
import mongoose from 'mongoose'

export function createMeApi() {
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  router.get('/api/me', async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.json({ authenticated: false, user: null })

    const userDoc = r.user
    const telegramUserId =
      typeof userDoc.telegramUserId === 'string' && userDoc.telegramUserId ? userDoc.telegramUserId : null
    const publicId = telegramUserId ? `tg_${telegramUserId}` : String(userDoc._id)

    res.json({
      authenticated: true,
      user: {
        id: publicId,
        role: typeof userDoc.role === 'string' && userDoc.role ? userDoc.role : 'pending',
        telegramUserId,
        username: userDoc.username ?? null,
        firstName: userDoc.firstName ?? null,
        lastName: userDoc.lastName ?? null,
        photoUrl: userDoc.photoUrl ?? null,
        mongoId: String(userDoc._id),
        createdAt: userDoc.createdAt ?? null,
        updatedAt: userDoc.updatedAt ?? null,
      },
    })
  })

  router.patch('/api/me/role', requireAuth, async (req, res) => {
    const role = typeof req.body?.role === 'string' ? req.body.role.trim() : ''
    if (role !== 'customer' && role !== 'executor') {
      return res.status(400).json({ error: 'invalid_role' })
    }

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.user?.id || ''))
    } catch {
      oid = null
    }
    if (!oid) return res.status(401).json({ error: 'unauthorized' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    const users = db.collection('users')

    const existing = await users.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!existing) return res.status(404).json({ error: 'user_not_found' })

    const currentRole = typeof existing.role === 'string' && existing.role ? existing.role : 'pending'
    if (currentRole !== 'pending' && currentRole !== role) {
      return res.status(409).json({ error: 'role_already_set', role: currentRole })
    }
    if (currentRole === role) return res.json({ ok: true, role })

    await users.updateOne({ _id: oid }, { $set: { role, updatedAt: new Date() } })
    return res.json({ ok: true, role })
  })

  return router
}

