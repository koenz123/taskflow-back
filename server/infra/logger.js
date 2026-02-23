function nowIso() {
  return new Date().toISOString()
}

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

function resolveLevel() {
  const env = String(process.env.LOG_LEVEL || '').trim().toLowerCase()
  if (env && LEVELS[env] != null) return env
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug'
}

function shouldLog(level, minLevel) {
  return (LEVELS[level] ?? 100) >= (LEVELS[minLevel] ?? 20)
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ error: 'non_serializable' })
  }
}

export function createLogger() {
  const minLevel = resolveLevel()

  function write(level, msg, fields) {
    if (!shouldLog(level, minLevel)) return
    const record = {
      ts: nowIso(),
      level,
      msg,
      ...fields,
    }
    // Single-line JSON is easier to search/parse.
    // Use stdout for all levels to keep Docker logs consistent.
    console.log(safeJson(record))
  }

  return {
    debug: (msg, fields = {}) => write('debug', msg, fields),
    info: (msg, fields = {}) => write('info', msg, fields),
    warn: (msg, fields = {}) => write('warn', msg, fields),
    error: (msg, fields = {}) => write('error', msg, fields),
  }
}

