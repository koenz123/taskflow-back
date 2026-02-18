import { fileURLToPath } from 'node:url'
import path from 'node:path'
import express from 'express'
import cors from 'cors'
import { createVideoApi } from './videoApi.js'
import { createAuthApi } from './authApi.js'
import { attachRequestId, createAuditor } from './audit.js'
import { connectMongo } from './db.js'
import { logEvent } from './logEvent.js'
import { createGoalsApi } from './goalsApi.js'
import { createBalanceRepo } from './balanceRepo.js'
import { createBalanceApi } from './balanceApi.js'
import { createEventsReadApi } from './eventsReadApi.js'
import { createLogger } from './logger.js'
import { requestContextLogger } from './requestContext.js'
import { startTelegramBot } from './telegramBot.js'
import { createNotifyApi } from './notifyApi.js'
import { createAdminApi } from './adminApi.js'
import { createMeApi } from './meApi.js'
import { createTasksApi } from './tasksApi.js'
import { createNotificationsApi } from './notificationsApi.js'
import { createApplicationsApi } from './applicationsApi.js'
import { createContractsApi } from './contractsApi.js'
import { createAssignmentsApi } from './assignmentsApi.js'

const PORT = process.env.PORT || 4000
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.join(__dirname, 'data')
const UPLOADS_DIR = path.join(__dirname, 'uploads', 'videos')
const WORKS_FILE = path.join(DATA_DIR, 'works.json')

const app = express()
// Respect X-Forwarded-* headers (needed for correct req.secure behind a reverse proxy)
app.set('trust proxy', 1)
// Allow cookies (tf_token) to be set/sent when frontend uses CORS requests.
app.use(cors({ origin: true, credentials: true }))
app.use(attachRequestId)

const logger = createLogger()
app.locals.logger = logger
app.use(requestContextLogger(logger))

const audit = createAuditor({
  // По умолчанию пишем в /app/data/audit.log (volume taskflow_back_data).
  filePath: process.env.AUDIT_LOG_FILE || path.join(DATA_DIR, 'audit.log'),
  toConsole: process.env.AUDIT_TO_CONSOLE ? process.env.AUDIT_TO_CONSOLE !== '0' : true,
})
app.locals.audit = audit
app.locals.logEvent = logEvent
console.log('[audit] enabled', {
  filePath: process.env.AUDIT_LOG_FILE || path.join(DATA_DIR, 'audit.log'),
  toConsole: process.env.AUDIT_TO_CONSOLE ? process.env.AUDIT_TO_CONSOLE !== '0' : true,
})

// Balance (simple JSON repo for now)
const balanceRepo = createBalanceRepo({ dataDir: DATA_DIR })
app.locals.balanceRepo = balanceRepo

// Connect Mongo in background (events/audit can still work if Mongo is down).
connectMongo().then((r) => console.log('[mongo] enabled:', Boolean(r.enabled))).catch(() => {})

// Авто-аудит для всех "записывающих" запросов (POST/PUT/PATCH/DELETE).
// Если конкретный роут уже записал более семантическое audit-событие, то второе не пишем.
app.use((req, res, next) => {
  const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
  if (!isWrite) return next()

  res.on('finish', () => {
    const alreadyAudited = Array.isArray(req._auditEvents) && req._auditEvents.length > 0
    if (alreadyAudited) return
    audit(req, 'http.write', {
      result: res.statusCode >= 400 ? 'error' : 'ok',
      meta: { statusCode: res.statusCode },
    })
  })

  next()
})

app.use(
  createVideoApi({
    worksFile: WORKS_FILE,
    uploadsDir: UPLOADS_DIR,
    maxFileBytes: 2 * 1024 * 1024 * 1024,
    audit,
    logEvent,
  }),
)

app.use(
  createAuthApi({
    dataDir: DATA_DIR,
    appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:5173',
    audit,
    logEvent,
  }),
)

app.use(
  createAdminApi({
    dataDir: DATA_DIR,
  }),
)

app.use(createMeApi())
app.use(createTasksApi())
app.use(
  createNotificationsApi({
    dataDir: DATA_DIR,
  }),
)
app.use(createApplicationsApi())
app.use(createContractsApi())
app.use(createAssignmentsApi())

app.use(
  createGoalsApi({
    dataDir: DATA_DIR,
  }),
)

app.use(
  createBalanceApi({
    balanceRepo,
  }),
)

app.use(createEventsReadApi())

app.use(
  createNotifyApi({
    dataDir: DATA_DIR,
  }),
)

// Telegram bot (long polling). Disabled if TELEGRAM_BOT_TOKEN isn't set.
// Запускаем после того, как подключили все роуты.
startTelegramBot({ dataDir: DATA_DIR })

// Global JSON error handler (so 500s are visible and debuggable).
app.use((err, req, res, _next) => {
  const message = err instanceof Error ? err.message : String(err)
  const stack = err instanceof Error ? err.stack : null
  const ctx = req._requestContext ?? null
  logger.error('Unhandled error', {
    requestId: req.requestId || null,
    userId: req.user?.id ?? null,
    error: message,
    stack,
    context: ctx,
  })
  res.status(500).json({
    error: 'server_error',
    message,
    requestId: req.requestId || null,
  })
})

// Bind explicitly so Docker port mapping works reliably on all hosts.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Video server listening on ${PORT}`)
})
