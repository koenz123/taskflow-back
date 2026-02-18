import express from 'express'
import mongoose from 'mongoose'
import { requireAuth } from './auth.js'
import { tryResolveAuthUser } from './authSession.js'

function safeTrim(v) {
  if (v == null) return null
  const s = String(v).trim()
  return s ? s : null
}

function toDto(doc) {
  if (!doc) return null
  const { _id, userId, createdAt, updatedAt, ...rest } = doc
  return {
    id: String(_id),
    userId: userId ?? null,
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
    ...rest,
  }
}

export function createGenericCrudApi({ basePath, collectionName, maxLimit = 200 }) {
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  // Soft auth for list endpoints: if not logged in, return empty list (prevents infinite retry storms on frontend).
  router.get(basePath, async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.json([])
    const userId = r.userId

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const col = db.collection(collectionName)
    const items = await col
      .find({ userId: String(userId) })
      .sort({ createdAt: -1 })
      .limit(maxLimit)
      .toArray()

    res.json(items.map(toDto))
  })

  router.post(basePath, requireAuth, async (req, res) => {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'unauthorized' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const now = new Date()
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    // If frontend sends empty body, still allow creating a placeholder item.
    const docToInsert = {
      userId: String(userId),
      ...body,
      createdAt: now,
      updatedAt: now,
    }
    // Prevent overriding userId via body
    docToInsert.userId = String(userId)

    const col = db.collection(collectionName)
    const insertRes = await col.insertOne(docToInsert)
    const doc = await col.findOne({ _id: insertRes.insertedId })
    res.status(201).json(toDto(doc))
  })

  router.patch(`${basePath}/:id`, requireAuth, async (req, res) => {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'unauthorized' })

    const id = safeTrim(req.params.id)
    if (!id) return res.status(400).json({ error: 'bad_id' })

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(id)
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const update = { $set: { ...body, updatedAt: new Date() } }
    // Prevent overriding owner
    if ('userId' in update.$set) delete update.$set.userId

    const col = db.collection(collectionName)
    const existing = await col.findOne({ _id: oid, userId: String(userId) })
    if (!existing) return res.status(404).json({ error: 'not_found' })

    await col.updateOne({ _id: oid, userId: String(userId) }, update)
    const doc = await col.findOne({ _id: oid })
    res.json(toDto(doc))
  })

  return router
}

