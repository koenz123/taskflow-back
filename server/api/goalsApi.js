import path from 'node:path'
import { promises as fs } from 'node:fs'
import express from 'express'
import { requireAuth } from '../auth/auth.js'
import { logBusinessEvent } from '../infra/logBusinessEvent.js'

async function readJson(filePath, fallback) {
  try {
    const txt = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(txt)
  } catch {
    return fallback
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function normalizeSource(value) {
  if (value == null) return null
  const s = String(value).trim()
  if (!s) return null
  if (s.length > 50) return null
  return s
}

export function createGoalsApi({ dataDir }) {
  const router = express.Router()
  const GOALS_FILE = path.join(dataDir, 'goals.json')
  const GOAL_REWARD = Number.isFinite(Number(process.env.GOAL_REWARD)) ? Number(process.env.GOAL_REWARD) : 10

  router.use(express.json({ limit: '1mb' }))

  function normalizeGoals(value) {
    return Array.isArray(value) ? value : []
  }

  router.get('/api/goals', requireAuth, async (req, res, next) => {
    try {
      const goals = normalizeGoals(await readJson(GOALS_FILE, []))
      const mine = goals.filter((g) => g.userId === req.user.id).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      res.json(mine)
    } catch (e) {
      console.error('[goalsApi] list failed', e)
      next(e)
    }
  })

  router.post('/api/goals', requireAuth, async (req, res, next) => {
    try {
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
      if (!title) return res.status(400).json({ error: 'missing_title' })

      const sourceHeader = req.headers['x-goal-source'] ?? req.headers['x-event-source'] ?? null
      const source = normalizeSource(req.body?.source ?? sourceHeader)
      if ((req.body?.source != null || sourceHeader != null) && !source) {
        return res.status(400).json({ error: 'invalid_source' })
      }

      const goals = normalizeGoals(await readJson(GOALS_FILE, []))
      const goal = {
        id: newId('goal'),
        title,
        userId: req.user.id,
        source,
        createdAt: new Date().toISOString(),
        completedAt: null,
      }
      goals.push(goal)
      await writeJson(GOALS_FILE, goals)

      await logBusinessEvent({
        req,
        event: 'GOAL_CREATED',
        target: goal.id,
        meta: { title: goal.title, source: goal.source ?? 'manual' },
      })

      res.json(goal)
    } catch (e) {
      console.error('[goalsApi] create failed', e)
      next(e)
    }
  })

  router.post('/api/goals/:id/complete', requireAuth, async (req, res, next) => {
    try {
      const goalId = String(req.params.id || '').trim()
      if (!goalId) return res.status(400).json({ error: 'missing_id' })

      const goals = normalizeGoals(await readJson(GOALS_FILE, []))
      const idx = goals.findIndex((g) => g.id === goalId && g.userId === req.user.id)
      if (idx === -1) return res.status(404).json({ error: 'not_found' })

      const goal = goals[idx]
      if (goal.completedAt) return res.status(400).json({ error: 'already_completed' })

      const sourceHeader = req.headers['x-goal-source'] ?? req.headers['x-event-source'] ?? null
      const actionSource = normalizeSource(req.body?.source ?? sourceHeader) ?? goal.source ?? 'manual'

      // 1) отметить выполненной
      goal.completedAt = new Date().toISOString()
      goals[idx] = goal
      await writeJson(GOALS_FILE, goals)

      await logBusinessEvent({
        req,
        event: 'GOAL_COMPLETED',
        target: goal.id,
        meta: { reward: GOAL_REWARD, title: goal.title, source: actionSource },
      })

      // 2) начислить баланс
      const balanceRepo = req.app?.locals?.balanceRepo
      if (!balanceRepo?.adjust) {
        return res.status(500).json({ error: 'server_error', message: 'balance_not_configured' })
      }
      const newBalance = await balanceRepo.adjust(req.user.id, GOAL_REWARD)

      // 3) лог изменения баланса
      await logBusinessEvent({
        req,
        event: 'BALANCE_CHANGED',
        actor: req.user.id,
        target: null,
        meta: {
          delta: GOAL_REWARD,
          reason: 'goal_completed',
          newBalance,
          source: actionSource,
        },
      })

      res.json({ ok: true, goalId: goal.id, reward: GOAL_REWARD, newBalance })
    } catch (e) {
      console.error('[goalsApi] complete failed', e)
      next(e)
    }
  })

  router.delete('/api/goals/:id', requireAuth, async (req, res, next) => {
    try {
      const goalId = String(req.params.id || '').trim()
      if (!goalId) return res.status(400).json({ error: 'missing_id' })

      const goals = normalizeGoals(await readJson(GOALS_FILE, []))
      const idx = goals.findIndex((g) => g.id === goalId && g.userId === req.user.id)
      if (idx === -1) return res.status(404).json({ error: 'not_found' })

      const [goal] = goals.splice(idx, 1)
      await writeJson(GOALS_FILE, goals)

      await logBusinessEvent({
        req,
        event: 'GOAL_DELETED',
        target: goal.id,
        meta: { title: goal.title, source: goal.source ?? 'manual' },
      })

      res.status(204).end()
    } catch (e) {
      console.error('[goalsApi] delete failed', e)
      next(e)
    }
  })

  return router
}

