import { connectMongo, isMongoEnabled } from './db.js'
import { Event } from '../../models/Event.js'

const ALLOWED_TYPES = new Set([
  // Цели
  'GOAL_CREATED',
  'GOAL_UPDATED',
  'GOAL_COMPLETED',
  'GOAL_DELETED',
  // Задания
  'TASK_CREATED',
  'TASK_UPDATED',
  'TASK_DELETED',
  'TASK_COMPLETED',
  // Награды/баланс
  'REWARD_CREATED',
  'REWARD_REDEEMED',
  'BALANCE_CHANGED',
  // Аутентификация
  'USER_LOGIN',
])

function shouldConsole() {
  // default: on
  return process.env.EVENTS_TO_CONSOLE ? process.env.EVENTS_TO_CONSOLE !== '0' : true
}

export async function logEvent({ userId = null, type, entityId = null, meta = null } = {}) {
  const normalizedType = String(type || '').trim()
  if (!normalizedType) throw new Error('missing_type')
  if (!ALLOWED_TYPES.has(normalizedType)) {
    // Жёстко ограничиваем Event-логирование только “значимыми” типами
    // (чтобы UI/случайная логика не засоряла коллекцию).
    if (shouldConsole()) {
      console.warn('[event] ignored type (not allowed):', normalizedType)
    }
    return { stored: false, ignored: true }
  }

  const actor = arguments?.[0]?.actor ?? userId
  const target = arguments?.[0]?.target ?? entityId
  const ts = arguments?.[0]?.ts
  const createdAt = arguments?.[0]?.createdAt

  const actorId = actor ? String(actor) : null
  const targetId = target ? String(target) : null
  const when = ts instanceof Date ? ts : createdAt instanceof Date ? createdAt : new Date()

  if (!isMongoEnabled()) {
    if (shouldConsole()) {
      console.log(
        '[event]',
        JSON.stringify({
          actor: actorId,
          target: targetId,
          userId: actorId,
          entityId: targetId,
          type: normalizedType,
          meta,
          ts: when.toISOString(),
          stored: false,
        }),
      )
    }
    return { stored: false }
  }

  const conn = await connectMongo()
  if (!conn.enabled) {
    if (shouldConsole()) {
      console.log(
        '[event]',
        JSON.stringify({
          actor: actorId,
          target: targetId,
          userId: actorId,
          entityId: targetId,
          type: normalizedType,
          meta,
          ts: when.toISOString(),
          stored: false,
        }),
      )
    }
    return { stored: false }
  }

  const doc = await Event.create({
    // New fields
    actor: actorId,
    target: targetId,
    ts: when,
    // Back-compat fields
    userId: actorId,
    type: normalizedType,
    entityId: targetId,
    meta,
    createdAt: when,
  })

  if (shouldConsole()) {
    console.log(
      '[event]',
      JSON.stringify({
        id: String(doc._id),
        actor: doc.actor ?? null,
        target: doc.target ?? null,
        userId: doc.userId ?? null,
        type: doc.type,
        entityId: doc.entityId ?? null,
        ts: (doc.ts || doc.createdAt).toISOString(),
        stored: true,
      }),
    )
  }

  return { stored: true, id: String(doc._id) }
}

