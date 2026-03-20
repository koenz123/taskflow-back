import express from 'express'
import mongoose from 'mongoose'
import { tryResolveAuthUser } from '../auth/authSession.js'
import { requireAuth } from '../auth/auth.js'

let ensureIndexesPromise = null
async function ensureIndexes(db) {
  if (ensureIndexesPromise) return ensureIndexesPromise
  ensureIndexesPromise = (async () => {
    const brands = db.collection('brands')
    await brands.createIndex({ ownerUserId: 1, createdAt: -1 })
    await brands.createIndex({ ownerMongoId: 1, createdAt: -1 })
  })().catch((e) => {
    ensureIndexesPromise = null
    console.warn('[brandsApi] ensureIndexes failed', e instanceof Error ? e.message : String(e))
  })
  return ensureIndexesPromise
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function trimOrNull(v, { maxLen = 200 } = {}) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  return s.length > maxLen ? s.slice(0, maxLen) : s
}

function normalizeLogoUrl(v) {
  const s = trimOrNull(v, { maxLen: 2048 })
  if (!s) return null
  if (s.startsWith('/uploads/')) return s
  if (s.startsWith('http://') || s.startsWith('https://')) return s
  return null
}

function normalizeGuidelines(v) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  // keep generous limit for markdown/text
  return s.length > 50_000 ? s.slice(0, 50_000) : s
}

function normalizeSocials(v) {
  if (!isObject(v)) return null
  const out = {}
  const entries = Object.entries(v)
  for (const [kRaw, val] of entries.slice(0, 50)) {
    const k = typeof kRaw === 'string' ? kRaw.trim() : ''
    if (!k) continue
    const s = trimOrNull(val, { maxLen: 2048 })
    if (!s) continue
    out[k] = s
  }
  return Object.keys(out).length ? out : {}
}

function toBrandDto(doc) {
  if (!doc) return null
  const { _id, createdAt, updatedAt, ...rest } = doc
  return {
    id: String(_id),
    ...rest,
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
  }
}

function getAuthIds(r) {
  const userMongoId = String(r.userId)
  const telegramUserId =
    typeof r.user?.telegramUserId === 'string' && r.user.telegramUserId ? r.user.telegramUserId : null
  const userPublicId = telegramUserId ? `tg_${telegramUserId}` : userMongoId
  const role = typeof r.user?.role === 'string' && r.user.role ? r.user.role : 'pending'
  return { userMongoId, userPublicId, role }
}

function parseObjectId(value) {
  const s = typeof value === 'string' ? value.trim() : ''
  if (!s) return null
  try {
    return new mongoose.Types.ObjectId(s)
  } catch {
    return null
  }
}

export function createBrandsApi() {
  const router = express.Router()
  router.use(express.json({ limit: '256kb' }))

  // GET /api/brands — список брендов текущего пользователя (customer)
  router.get('/api/brands', requireAuth, async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const { userMongoId, userPublicId, role } = getAuthIds(r)
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    await ensureIndexes(db)
    const brands = db.collection('brands')

    const items = await brands
      .find(
        { $or: [{ ownerUserId: userPublicId }, { ownerMongoId: userMongoId }] },
        { readPreference: 'primary' },
      )
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray()

    return res.json(items.map(toBrandDto))
  })

  // POST /api/brands — создать бренд (customer)
  router.post('/api/brands', requireAuth, async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const { userMongoId, userPublicId, role } = getAuthIds(r)
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })

    const name = trimOrNull(req.body?.name, { maxLen: 120 })
    if (!name) return res.status(400).json({ error: 'invalid_name' })

    const logoUrl = normalizeLogoUrl(req.body?.logoUrl)
    const socials = normalizeSocials(req.body?.socials)
    const guidelines = normalizeGuidelines(req.body?.guidelines)

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    await ensureIndexes(db)
    const brands = db.collection('brands')

    const now = new Date()
    const doc = {
      ownerMongoId: userMongoId,
      ownerUserId: userPublicId,
      name,
      logoUrl: logoUrl ?? null,
      socials: socials ?? {},
      guidelines: guidelines ?? null,
      createdAt: now,
      updatedAt: now,
    }
    const insertRes = await brands.insertOne(doc)
    const created = await brands.findOne({ _id: insertRes.insertedId }, { readPreference: 'primary' })
    return res.status(201).json(toBrandDto(created))
  })

  // PATCH /api/brands/:brandId — обновить бренд (customer, owner only)
  router.patch('/api/brands/:brandId', requireAuth, async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const { userMongoId, userPublicId, role } = getAuthIds(r)
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })

    const brandOid = parseObjectId(req.params.brandId)
    if (!brandOid) return res.status(400).json({ error: 'bad_brand_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    await ensureIndexes(db)
    const brands = db.collection('brands')

    const existing = await brands.findOne({ _id: brandOid }, { readPreference: 'primary' })
    if (!existing) return res.status(404).json({ error: 'not_found' })
    const isOwner = existing.ownerUserId === userPublicId || existing.ownerMongoId === userMongoId
    if (!isOwner) return res.status(403).json({ error: 'forbidden' })

    const update = { $set: { updatedAt: new Date() } }
    if (req.body?.name !== undefined) {
      const name = trimOrNull(req.body?.name, { maxLen: 120 })
      if (!name) return res.status(400).json({ error: 'invalid_name' })
      update.$set.name = name
    }
    if (req.body?.logoUrl !== undefined) {
      const logoUrl = normalizeLogoUrl(req.body?.logoUrl)
      if (req.body?.logoUrl != null && !logoUrl) return res.status(400).json({ error: 'invalid_logoUrl' })
      update.$set.logoUrl = logoUrl ?? null
    }
    if (req.body?.socials !== undefined) {
      const socials = normalizeSocials(req.body?.socials)
      if (req.body?.socials != null && socials === null) return res.status(400).json({ error: 'invalid_socials' })
      update.$set.socials = socials ?? {}
    }
    if (req.body?.guidelines !== undefined) {
      const guidelines = normalizeGuidelines(req.body?.guidelines)
      update.$set.guidelines = guidelines ?? null
    }

    await brands.updateOne({ _id: brandOid }, update)
    const fresh = await brands.findOne({ _id: brandOid }, { readPreference: 'primary' })

    // Best-effort: keep tasks snapshots in sync for this owner.
    const nextName = typeof fresh?.name === 'string' && fresh.name.trim() ? fresh.name.trim() : null
    const nextLogoUrl = typeof fresh?.logoUrl === 'string' && fresh.logoUrl.trim() ? fresh.logoUrl.trim() : null
    await db.collection('tasks').updateMany(
      {
        brandId: String(brandOid),
        $or: [{ createdByUserId: userPublicId }, { createdByUserId: userMongoId }, { createdByMongoId: userMongoId }],
      },
      { $set: { brandName: nextName, brandLogoUrl: nextLogoUrl, updatedAt: new Date() } },
    )

    return res.json(toBrandDto(fresh))
  })

  // DELETE /api/brands/:brandId — удалить бренд (customer, owner only)
  router.delete('/api/brands/:brandId', requireAuth, async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.status(401).json({ error: r.error })
    const { userMongoId, userPublicId, role } = getAuthIds(r)
    if (role !== 'customer') return res.status(403).json({ error: 'forbidden' })

    const brandOid = parseObjectId(req.params.brandId)
    if (!brandOid) return res.status(400).json({ error: 'bad_brand_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })
    await ensureIndexes(db)
    const brands = db.collection('brands')
    const tasks = db.collection('tasks')

    const existing = await brands.findOne({ _id: brandOid }, { readPreference: 'primary' })
    if (!existing) return res.status(404).json({ error: 'not_found' })
    const isOwner = existing.ownerUserId === userPublicId || existing.ownerMongoId === userMongoId
    if (!isOwner) return res.status(403).json({ error: 'forbidden' })

    // Best-effort: detach from tasks of this owner to avoid dangling brandId in UI.
    await tasks.updateMany(
      {
        brandId: String(brandOid),
        $or: [{ createdByUserId: userPublicId }, { createdByUserId: userMongoId }, { createdByMongoId: userMongoId }],
      },
      { $set: { brandId: null, brandName: null, brandLogoUrl: null, updatedAt: new Date() } },
    )

    await brands.deleteOne({ _id: brandOid })
    return res.json({ ok: true })
  })

  return router
}

