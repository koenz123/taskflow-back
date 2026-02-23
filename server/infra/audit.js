import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ error: 'non_serializable' })
  }
}

function nowIso() {
  return new Date().toISOString()
}

function getClientIp(req) {
  // If behind nginx later, it can set X-Forwarded-For.
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim()
  return req.ip || req.socket?.remoteAddress || null
}

function sanitizeActor(actor) {
  if (typeof actor === 'string') {
    const trimmed = actor.trim()
    return trimmed || null
  }
  if (!actor || typeof actor !== 'object') return null
  const out = {}
  if (typeof actor.userId === 'string') out.userId = actor.userId
  if (typeof actor.email === 'string') out.email = actor.email
  if (typeof actor.role === 'string') out.role = actor.role
  return Object.keys(out).length ? out : null
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath)
  return fs.mkdir(dir, { recursive: true })
}

export function createAuditor({
  filePath = process.env.AUDIT_LOG_FILE || null,
  toConsole = process.env.AUDIT_TO_CONSOLE ? process.env.AUDIT_TO_CONSOLE !== '0' : true,
} = {}) {
  let chain = Promise.resolve()

  async function writeLine(line) {
    if (!filePath) return
    await ensureDir(filePath)
    await fs.appendFile(filePath, `${line}\n`, 'utf-8')
  }

  function audit(req, event, payload = {}) {
    if (req) {
      req._auditEvents = Array.isArray(req._auditEvents) ? req._auditEvents : []
      req._auditEvents.push(String(event))
    }

    const record = {
      ts: nowIso(),
      event: String(event),
      requestId: req.requestId || null,
      http: {
        method: req.method,
        url: req.originalUrl || req.url,
      },
      ip: getClientIp(req),
      origin: typeof req.headers.origin === 'string' ? req.headers.origin : null,
      referer: typeof req.headers.referer === 'string' ? req.headers.referer : null,
      ua: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      actor: sanitizeActor(payload.actor),
      target: payload.target ?? null,
      meta: payload.meta ?? null,
      result: payload.result ?? 'ok',
    }

    const line = safeJson(record)

    if (toConsole) {
      // Single-line JSON helps grep/aggregation.
      console.log(`[audit] ${line}`)
    }

    // Serialize writes to keep ordering predictable.
    chain = chain
      .then(() => writeLine(line))
      .catch((e) => {
        console.error('[audit] failed to write audit log', e)
      })

    return record
  }

  // Convenience for business events:
  // await audit.log({ req, event: 'GOAL_CREATED', actor: 'user_123', target: 'goal_456', meta: {...} })
  audit.log = async ({ req, event, actor, target, meta, result } = {}) => {
    if (!req) throw new Error('missing_req')
    const actorId = actor ?? req.user?.id ?? null
    return audit(req, event, { actor: actorId, target, meta, result })
  }

  return audit
}

export function attachRequestId(req, _res, next) {
  req.requestId = req.requestId || crypto.randomUUID()
  next()
}

