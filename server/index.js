import { fileURLToPath } from 'node:url'
import path from 'node:path'
import express from 'express'
import cors from 'cors'
import { createVideoApi } from './api/videoApi.js'
import { createAuthApi } from './api/authApi.js'
import { createConnectApi } from './api/connectApi.js'
import oauthRoutes from './oauth/oauth.routes.js'
import { attachRequestId, createAuditor } from './infra/audit.js'
import { connectMongo } from './infra/db.js'
import { logEvent } from './infra/logEvent.js'
import { createGoalsApi } from './api/goalsApi.js'
import { createBalanceRepo } from './services/balanceRepo.js'
import { createBalanceApi } from './api/balanceApi.js'
import { createEventsReadApi } from './api/eventsReadApi.js'
import { createLogger } from './infra/logger.js'
import { requestContextLogger } from './infra/requestContext.js'
import { startTelegramBot } from './integrations/telegramBot.js'
import { createNotifyApi } from './api/notifyApi.js'
import { createAdminApi } from './api/adminApi.js'
import { createMeApi } from './api/meApi.js'
import { createTasksApi } from './api/tasksApi.js'
import { createNotificationsApi } from './api/notificationsApi.js'
import { createApplicationsApi } from './api/applicationsApi.js'
import { createContractsApi } from './api/contractsApi.js'
import { createAssignmentsApi } from './api/assignmentsApi.js'
import { createSubmissionsApi } from './api/submissionsApi.js'
import { createDisputesApi } from './api/disputesApi.js'
import { createDisputeMessagesApi } from './api/disputeMessagesApi.js'
import { createSupportApi } from './api/supportApi.js'
import { createUsersApi } from './api/usersApi.js'
import { createUploadsApi } from './api/uploadsApi.js'
import { createRatingsApi } from './api/ratingsApi.js'
import mongoose from 'mongoose'
import { runAssignmentJobs } from './jobs/assignmentJobs.js'

const PORT = process.env.PORT || 4000
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const APP_ROOT = path.resolve(__dirname, '..')
const DATA_DIR = path.join(APP_ROOT, 'data')
const UPLOADS_DIR = path.join(APP_ROOT, 'uploads', 'videos')
const UPLOADS_FILES_DIR = path.join(APP_ROOT, 'uploads', 'files')
const WORKS_FILE = path.join(DATA_DIR, 'works.json')

const app = express()
// Respect X-Forwarded-* headers (needed for correct req.secure behind a reverse proxy)
app.set('trust proxy', 1)
// APIs must be real-time; 304/ETag breaks clients expecting JSON bodies.
app.disable('etag')
// Allow cookies (tf_token) to be set/sent when frontend uses CORS requests.
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
)
app.use(attachRequestId)

// Allow OAuth popups to keep window.opener relationship.
// (Primarily relevant for frontend HTML, but safe for API responses too.)
app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')
  next()
})

// Never cache API responses in browsers/proxies.
app.use((req, res, next) => {
  if (req.method === 'GET' && typeof req.path === 'string' && req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
  }
  next()
})

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
app.locals.dataDir = DATA_DIR

// Connect Mongo in background (events/audit can still work if Mongo is down).
connectMongo().then((r) => console.log('[mongo] enabled:', Boolean(r.enabled))).catch(() => {})

// Background jobs (sanctions, timers). Runs only when Mongo is ready.
const JOBS_ENABLED = process.env.ASSIGNMENT_JOBS_ENABLED ? process.env.ASSIGNMENT_JOBS_ENABLED !== '0' : true
let jobsRunning = false
function startBackgroundJobs() {
  if (!JOBS_ENABLED) return
  const tick = async () => {
    if (jobsRunning) return
    if (mongoose.connection.readyState !== 1) return
    const db = mongoose.connection.db
    if (!db) return
    jobsRunning = true
    try {
      await runAssignmentJobs({ db, balanceRepo: app.locals.balanceRepo, nowMs: Date.now() })
    } catch {
      // ignore; jobs are best-effort and should never crash the server
    } finally {
      jobsRunning = false
    }
  }
  // Run soon after boot, then every minute.
  setTimeout(() => void tick(), 5_000)
  setInterval(() => void tick(), 60_000)
}

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
    maxFileBytes: 5 * 1024 * 1024 * 1024,
    audit,
    logEvent,
  }),
)

app.use(
  createUploadsApi({
    uploadsDir: UPLOADS_FILES_DIR,
    maxFileBytes: 5 * 1024 * 1024 * 1024,
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
app.use(createConnectApi())
app.use('/api/oauth', oauthRoutes)

app.use(
  createAdminApi({
    dataDir: DATA_DIR,
  }),
)

app.use(createMeApi())
app.use(createUsersApi())
app.use(createTasksApi())
app.use(
  createNotificationsApi({
    dataDir: DATA_DIR,
  }),
)
app.use(createApplicationsApi())
app.use(createContractsApi())
app.use(createAssignmentsApi())
app.use(createSubmissionsApi())
app.use(createDisputesApi())
app.use(createDisputeMessagesApi())
app.use(createSupportApi())
app.use(createRatingsApi())

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

startBackgroundJobs()

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
