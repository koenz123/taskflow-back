function pickHeader(req, name) {
  const v = req.headers?.[name]
  return typeof v === 'string' ? v : null
}

function getClientIp(req) {
  const xff = pickHeader(req, 'x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return req.ip || req.socket?.remoteAddress || null
}

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return body
  if (Array.isArray(body)) return body.slice(0, 50).map((x) => sanitizeBody(x))

  const out = {}
  for (const [k, v] of Object.entries(body)) {
    const key = String(k)
    const lowered = key.toLowerCase()
    if (
      lowered.includes('password') ||
      lowered.includes('pass') ||
      lowered.includes('token') ||
      lowered.includes('authorization') ||
      lowered.includes('cookie') ||
      lowered.includes('secret')
    ) {
      out[key] = '[redacted]'
      continue
    }
    if (typeof v === 'string' && v.length > 1000) {
      out[key] = `${v.slice(0, 200)}…[truncated ${v.length}]`
      continue
    }
    out[key] = sanitizeBody(v)
  }
  return out
}

export function requestContextLogger(logger) {
  return function requestLogger(req, res, next) {
    const start = Date.now()

    // attach per-request log helpers with requestId/userId
    req.log = {
      debug: (msg, fields = {}) =>
        logger.debug(msg, { requestId: req.requestId || null, userId: req.user?.id ?? null, ...fields }),
      info: (msg, fields = {}) =>
        logger.info(msg, { requestId: req.requestId || null, userId: req.user?.id ?? null, ...fields }),
      warn: (msg, fields = {}) =>
        logger.warn(msg, { requestId: req.requestId || null, userId: req.user?.id ?? null, ...fields }),
      error: (msg, fields = {}) =>
        logger.error(msg, { requestId: req.requestId || null, userId: req.user?.id ?? null, ...fields }),
    }

    // Incoming request (userId may be null at this point)
    logger.info('Incoming request', {
      requestId: req.requestId || null,
      method: req.method,
      url: req.originalUrl || req.url,
      userId: req.user?.id ?? null,
      ip: getClientIp(req),
      origin: pickHeader(req, 'origin'),
      ua: pickHeader(req, 'user-agent'),
    })

    res.on('finish', () => {
      logger.info('Request finished', {
        requestId: req.requestId || null,
        method: req.method,
        url: req.originalUrl || req.url,
        userId: req.user?.id ?? null,
        statusCode: res.statusCode,
        durationMs: Date.now() - start,
      })
    })

    // expose sanitized context for error handler
    req._requestContext = {
      method: req.method,
      url: req.originalUrl || req.url,
      params: req.params ?? null,
      query: req.query ?? null,
      body: sanitizeBody(req.body),
      ip: getClientIp(req),
      origin: pickHeader(req, 'origin'),
    }

    next()
  }
}

