function normalizeSource(value) {
  if (value == null) return null
  const s = String(value).trim()
  if (!s) return null
  if (s.length > 50) return null
  return s
}

function defaultSourceForEvent(event) {
  return event === 'USER_LOGIN' ? 'app' : 'manual'
}

function getSourceFromReq(req) {
  return (
    normalizeSource(req.headers?.['x-event-source']) ||
    normalizeSource(req.headers?.['x-goal-source']) ||
    normalizeSource(req.headers?.['x-task-source']) ||
    normalizeSource(req.headers?.['x-balance-source']) ||
    null
  )
}

function normalizeMeta(meta, source) {
  if (meta == null) return { source }
  if (typeof meta !== 'object' || Array.isArray(meta)) return { value: meta, source }
  return meta.source ? meta : { ...meta, source }
}

export async function logBusinessEvent({ req, event, target = null, meta = null, actor = undefined } = {}) {
  if (!req) throw new Error('missing_req')
  const audit = req.app?.locals?.audit
  const actorId = actor ?? req.user?.id ?? null
  const logEvent = req.app?.locals?.logEvent
  const source = normalizeSource(meta?.source) || getSourceFromReq(req) || defaultSourceForEvent(event)
  const metaWithSource = normalizeMeta(meta, source)

  // Support both styles:
  // - audit.log({ req, event, actor, target, meta })
  // - audit(req, event, { actor, target, meta })
  if (typeof audit?.log === 'function') {
    await audit.log({
      req,
      event,
      actor: actorId,
      target,
      meta: metaWithSource,
    })
  } else if (typeof audit === 'function') {
    audit(req, event, { actor: actorId, target, meta: metaWithSource })
  } else {
    throw new Error('audit_not_configured')
  }

  // Request-scoped context log (requestId/userId auto-injected)
  req.log?.info?.('Business event', {
    event,
    actor: actorId,
    target,
    meta: metaWithSource,
  })

  // Analytics storage (Mongo Event collection). Best-effort: do not break business flow if Mongo is down.
  if (typeof logEvent === 'function') {
    try {
      await logEvent({
        type: event,
        actor: actorId,
        target,
        meta: metaWithSource,
        ts: new Date(),
      })
    } catch (e) {
      req.log?.warn?.('Failed to store business event', {
        event,
        actor: actorId,
        target,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // unreachable
}

