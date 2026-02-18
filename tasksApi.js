import express from 'express'
import mongoose from 'mongoose'
import { requireAuth } from './auth.js'
import { tryResolveAuthUser } from './authSession.js'

function toTaskDto(doc) {
  if (!doc) return null
  return {
    id: String(doc._id),
    userId: doc.userId ?? null,
    title: doc.title ?? '',
    description: doc.description ?? null,
    status: doc.status ?? 'open',
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    completedAt: doc.completedAt ? new Date(doc.completedAt).toISOString() : null,
  }
}

export function createTasksApi() {
  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  // Soft auth list: return [] if not logged in (prevents retry storms).
  router.get('/api/tasks', async (req, res) => {
    const r = await tryResolveAuthUser(req)
    if (!r.ok) return res.json([])
    const userId = r.userId

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const tasks = db.collection('tasks')
    const items = await tasks
      .find({ userId: String(userId) })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray()

    res.json(items.map(toTaskDto))
  })

  router.post('/api/tasks', requireAuth, async (req, res) => {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'unauthorized' })

    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
    if (!title) return res.status(400).json({ error: 'missing_title' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const now = new Date()
    const tasks = db.collection('tasks')
    const insertRes = await tasks.insertOne({
      userId: String(userId),
      title,
      description: typeof req.body?.description === 'string' ? req.body.description.trim() : null,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    })

    const doc = await tasks.findOne({ _id: insertRes.insertedId })
    res.status(201).json(toTaskDto(doc))
  })

  router.patch('/api/tasks/:id', requireAuth, async (req, res) => {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'unauthorized' })

    let oid = null
    try {
      oid = new mongoose.Types.ObjectId(String(req.params.id))
    } catch {
      oid = null
    }
    if (!oid) return res.status(400).json({ error: 'bad_task_id' })

    const db = mongoose.connection.db
    if (!db) return res.status(500).json({ error: 'mongo_not_available' })

    const tasks = db.collection('tasks')
    const existing = await tasks.findOne({ _id: oid, userId: String(userId) })
    if (!existing) return res.status(404).json({ error: 'not_found' })

    const update = { $set: { updatedAt: new Date() } }
    if (typeof req.body?.title === 'string') update.$set.title = req.body.title.trim()
    if (typeof req.body?.description === 'string') update.$set.description = req.body.description.trim()
    if (typeof req.body?.status === 'string') update.$set.status = req.body.status.trim()
    if (req.body?.completedAt === null) update.$set.completedAt = null
    if (typeof req.body?.completedAt === 'string' && req.body.completedAt.trim()) {
      const d = new Date(req.body.completedAt)
      if (!Number.isNaN(d.getTime())) update.$set.completedAt = d
    }

    await tasks.updateOne({ _id: oid, userId: String(userId) }, update)
    const doc = await tasks.findOne({ _id: oid })
    res.json(toTaskDto(doc))
  })

  return router
}

