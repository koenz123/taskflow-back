import express from 'express'
import { tryResolveAuthUser } from '../auth/authSession.js'
import { requireAuth } from '../auth/auth.js'
import mongoose from 'mongoose'
import { canExecutorRespond, ensureSanctionsIndexes, violationLevelForExecutor } from '../services/executorSanctionsService.js'

export function createMeApi() {
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  router.get('/api/me', async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })

    const userDoc = r.user
    const telegramUserId =
      typeof userDoc.telegramUserId === 'string' && userDoc.telegramUserId ? userDoc.telegramUserId : null
    const publicId = telegramUserId ? `tg_${telegramUserId}` : String(userDoc._id)
    const fullName =
      (typeof userDoc.fullName === 'string' && userDoc.fullName.trim()) ||
      [userDoc.firstName, userDoc.lastName].filter(Boolean).join(' ').trim() ||
      userDoc.username ||
      publicId
    const socials =
      userDoc.socials && typeof userDoc.socials === 'object' && !Array.isArray(userDoc.socials)
        ? userDoc.socials
        : {}

    res.json({
      id: publicId,
      role: typeof userDoc.role === 'string' && userDoc.role ? userDoc.role : 'pending',
      telegramUserId,
      fullName,
      email: typeof userDoc.email === 'string' ? userDoc.email : '',
      phone: typeof userDoc.phone === 'string' ? userDoc.phone : '',
      username: userDoc.username ?? null,
      photoUrl: userDoc.photoUrl ?? null,
      socials,
      mongoId: String(userDoc._id),
      createdAt: userDoc.createdAt ?? null,
      updatedAt: userDoc.updatedAt ?? null,
    })
  })

  // Server-side sanctions state for the current user (executors only).
  router.get('/api/me/sanctions', async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })

    const userDoc = r.user
    const telegramUserId =
      typeof userDoc.telegramUserId === 'string' && userDoc.telegramUserId ? userDoc.telegramUserId : null
    const publicId = telegramUserId ? `tg_${telegramUserId}` : String(userDoc._id)
    const role = typeof userDoc.role === 'string' && userDoc.role ? userDoc.role : 'pending'

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    await ensureSanctionsIndexes(db)

    const restriction = await db.collection('executorRestrictions').findOne({ executorId: publicId }, { readPreference: 'primary' })
    const normalizedRestriction = {
      executorId: publicId,
      accountStatus: restriction?.accountStatus === 'banned' ? 'banned' : 'active',
      respondBlockedUntil:
        typeof restriction?.respondBlockedUntil === 'string' && restriction.respondBlockedUntil.trim()
          ? restriction.respondBlockedUntil
          : null,
      updatedAt: restriction?.updatedAt ? new Date(restriction.updatedAt).toISOString() : new Date().toISOString(),
    }

    const violations = await db
      .collection('executorViolations')
      .find({ executorId: publicId }, { readPreference: 'primary' })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray()

    const violationDtos = violations.map((v) => ({
      id: v?._id ? String(v._id) : '',
      executorId: publicId,
      type: v?.type === 'no_submit_24h' ? 'no_submit_24h' : 'no_start_12h',
      taskId: typeof v?.taskId === 'string' ? v.taskId : '',
      assignmentId: typeof v?.assignmentId === 'string' ? v.assignmentId : '',
      createdAt:
        v?.createdAt instanceof Date
          ? v.createdAt.toISOString()
          : typeof v?.createdAt === 'string'
            ? v.createdAt
            : new Date().toISOString(),
    }))

    const levels = {
      no_start_12h: await violationLevelForExecutor(db, publicId, 'no_start_12h', Date.now()),
      no_submit_24h: await violationLevelForExecutor(db, publicId, 'no_submit_24h', Date.now()),
    }

    const respondGuard = await canExecutorRespond(db, publicId, Date.now())

    return res.json({
      ok: true,
      role,
      executorId: publicId,
      restriction: normalizedRestriction,
      canRespond: respondGuard,
      levels,
      violations: violationDtos,
    })
  })

  router.patch('/api/me', requireAuth, async (req, res) => {
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

    const nextFullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim() : null
    const nextPhone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : null
    const nextEmailRaw = typeof req.body?.email === 'string' ? req.body.email.trim() : null
    const nextCompany = typeof req.body?.company === 'string' ? req.body.company.trim() : null
    const nextSocials = req.body?.socials && typeof req.body.socials === 'object' ? req.body.socials : null
    const nextAvatarDataUrl = typeof req.body?.avatarDataUrl === 'string' ? req.body.avatarDataUrl : null

    const update = { $set: { updatedAt: new Date() } }
    if (nextFullName !== null) update.$set.fullName = nextFullName
    if (nextPhone !== null) update.$set.phone = nextPhone
    if (nextCompany !== null) update.$set.company = nextCompany || null
    if (nextSocials !== null) update.$set.socials = nextSocials
    if (nextAvatarDataUrl !== null) update.$set.avatarDataUrl = nextAvatarDataUrl

    if (nextEmailRaw !== null) {
      const nextEmail = nextEmailRaw.trim().toLowerCase()
      if (!nextEmail) {
        update.$unset = { ...(update.$unset ?? {}), email: '', emailVerified: '' }
      } else {
        // If email changes, enforce uniqueness across users.
        const prevEmail = typeof existing.email === 'string' ? existing.email : ''
        if (prevEmail.toLowerCase() !== nextEmail) {
          const conflict = await users.findOne(
            { email: nextEmail },
            { projection: { _id: 1 }, readPreference: 'primary' },
          )
          if (conflict && String(conflict._id) !== String(existing._id)) {
            return res.status(409).json({ error: 'email_taken' })
          }
        }
        update.$set.email = nextEmail
        // No email verification flow here; keep it "true" for now to avoid blocking UX.
        update.$set.emailVerified = true
      }
    }

    await users.updateOne({ _id: oid }, update)
    const fresh = await users.findOne({ _id: oid }, { readPreference: 'primary' })
    if (!fresh) return res.status(500).json({ error: 'user_not_found' })

    const telegramUserId =
      typeof fresh.telegramUserId === 'string' && fresh.telegramUserId ? fresh.telegramUserId : null
    const publicId = telegramUserId ? `tg_${telegramUserId}` : String(fresh._id)
    const fullName =
      (typeof fresh.fullName === 'string' && fresh.fullName.trim()) ||
      [fresh.firstName, fresh.lastName].filter(Boolean).join(' ').trim() ||
      fresh.username ||
      publicId

    return res.json({
      id: publicId,
      role: typeof fresh.role === 'string' && fresh.role ? fresh.role : 'pending',
      telegramUserId,
      fullName,
      email: typeof fresh.email === 'string' ? fresh.email : '',
      phone: typeof fresh.phone === 'string' ? fresh.phone : '',
      username: fresh.username ?? null,
      photoUrl: fresh.photoUrl ?? null,
      mongoId: String(fresh._id),
      createdAt: fresh.createdAt ?? null,
      updatedAt: fresh.updatedAt ?? null,
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

