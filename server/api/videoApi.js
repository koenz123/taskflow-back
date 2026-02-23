import path from 'node:path'
import { promises as fs } from 'node:fs'
import express from 'express'
import multer from 'multer'
import { logBusinessEvent } from '../infra/logBusinessEvent.js'

export function createVideoApi({ worksFile, uploadsDir, maxFileBytes, audit = null, logEvent = null }) {
  const router = express.Router()

  const DATA_DIR = path.dirname(worksFile)
  const UPLOADS_DIR = uploadsDir
  const WORKS_FILE = worksFile

  const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'])
  const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.ogg', '.avi'])

  function guessMediaTypeFromUrl(url) {
    if (!url || typeof url !== 'string') return 'video'
    try {
      const normalized = new URL(url, 'http://localhost')
      const ext = path.extname(normalized.pathname).toLowerCase()
      if (IMAGE_EXTENSIONS.has(ext)) return 'photo'
      if (VIDEO_EXTENSIONS.has(ext)) return 'video'
    } catch {
      const slug = url.split('?')[0].split('#')[0].toLowerCase()
      const ext = path.extname(slug)
      if (IMAGE_EXTENSIONS.has(ext)) return 'photo'
      if (VIDEO_EXTENSIONS.has(ext)) return 'video'
    }
    return 'video'
  }

  async function ensureDirectories() {
    await fs.mkdir(UPLOADS_DIR, { recursive: true })
    await fs.mkdir(DATA_DIR, { recursive: true })
    try {
      await fs.access(WORKS_FILE)
    } catch {
      await fs.writeFile(WORKS_FILE, '[]', 'utf-8')
    }
  }

  async function readWorks() {
    const content = await fs.readFile(WORKS_FILE, 'utf-8')
    return JSON.parse(content)
  }

  async function writeWorks(items) {
    await fs.writeFile(WORKS_FILE, JSON.stringify(items, null, 2), 'utf-8')
  }

  function normalizeWorkRecord(work) {
    if (!work) return null
    const mediaUrl = typeof work.mediaUrl === 'string' ? work.mediaUrl : work.videoUrl
    if (!mediaUrl || typeof mediaUrl !== 'string') return null
    const mediaFileName = work.mediaFileName ?? work.videoFileName ?? null
    const mediaStorageName = work.mediaStorageName ?? work.videoStorageName ?? null
    const mediaType = work.mediaType ?? guessMediaTypeFromUrl(mediaUrl)

    return {
      ...work,
      mediaUrl,
      videoUrl: mediaUrl,
      mediaType,
      mediaFileName,
      mediaStorageName,
      videoFileName: mediaFileName,
      videoStorageName: mediaStorageName,
    }
  }

  function isMediaUrlValid(url) {
    if (typeof url !== 'string') return false
    if (url.startsWith('/videos/')) return true
    if (url.startsWith('http://') || url.startsWith('https://')) return true
    return false
  }

  function normalizeSource(value) {
    if (value == null) return null
    const s = String(value).trim()
    if (!s) return null
    if (s.length > 50) return null
    return s
  }

  function getActionSource(req, fallback) {
    const header = req.headers['x-event-source'] ?? req.headers['x-task-source'] ?? null
    return normalizeSource(req.body?.source ?? header) ?? fallback ?? 'manual'
  }

  const storage = multer.diskStorage({
    // IMPORTANT: multer expects cb(...) when destination is a function.
    // Returning a string here can cause the request to hang.
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const safeName = `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname || '')}`
      cb(null, safeName)
    },
  })

  const upload = multer({
    storage,
    limits: { fileSize: maxFileBytes },
    fileFilter: (_req, file, cb) => {
      if (!file.mimetype.startsWith('video/') && !file.mimetype.startsWith('image/')) {
        return cb(new Error('media_only'))
      }
      cb(null, true)
    },
  })

  // Ensure persistence exists early (and make routes wait for it)
  const ready = ensureDirectories().catch((e) => {
    console.error('[videoApi] ensureDirectories failed', e)
    throw e
  })

  router.use(async (_req, _res, next) => {
    try {
      await ready
      next()
    } catch (e) {
      next(e)
    }
  })

  router.use((req, _res, next) => {
    // Useful when debugging "upload stuck" cases
    req.on('aborted', () => {
      console.warn('[videoApi] request aborted by client', { method: req.method, url: req.originalUrl })
    })
    next()
  })

  router.use(express.json({ limit: '1mb' }))
  router.use('/videos', express.static(UPLOADS_DIR))

  router.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  router.get('/api/users/:userId/works', async (req, res, next) => {
    try {
      const works = await readWorks()
      let changed = false

      for (const work of works) {
        const mediaUrl = typeof work?.mediaUrl === 'string' ? work.mediaUrl : work?.videoUrl
        if (typeof mediaUrl !== 'string') continue
        const m = mediaUrl.match(/^https?:\/\/(?:localhost|127\.0\.0\.1):4000\/videos\/(.+)$/)
        if (!m) continue
        const fileName = m[1]
        const filePath = path.join(UPLOADS_DIR, fileName)
        try {
          await fs.access(filePath)
          work.mediaUrl = `/videos/${fileName}`
          work.videoUrl = work.mediaUrl
          if (!work.mediaStorageName) work.mediaStorageName = fileName
          if (!work.videoStorageName) work.videoStorageName = fileName
          if (!work.mediaFileName) work.mediaFileName = fileName
          if (!work.videoFileName) work.videoFileName = fileName
          changed = true
        } catch {
          // file missing - keep old URL
        }
      }

      if (changed) {
        await writeWorks(works)
      }

      const normalized = works.map(normalizeWorkRecord).filter(Boolean)
      const filtered = normalized
        .filter((work) => work.ownerId === req.params.userId && isMediaUrlValid(work.mediaUrl))
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      res.json(filtered)
    } catch (error) {
      console.error('[videoApi] list works: failed', error)
      next(error)
    }
  })

  router.post('/api/videos', upload.single('file'), async (req, res, next) => {
    try {
      const { ownerId, title, description, externalUrl } = req.body
      if (!ownerId || !title) {
        console.warn('[videoApi] create media: missing_fields', {
          ownerId: Boolean(ownerId),
          title: Boolean(title),
        })
        audit?.(req, 'TASK_CREATED', {
          actor: typeof ownerId === 'string' ? ownerId : null,
          result: 'error',
          meta: { error: 'missing_fields' },
        })
        return res.status(400).json({ error: 'missing_fields' })
      }

      const normalizedDescription = typeof description === 'string' ? description : ''

      const normalizedExternalUrl = externalUrl?.trim()
      if (
        normalizedExternalUrl &&
        !normalizedExternalUrl.startsWith('http://') &&
        !normalizedExternalUrl.startsWith('https://')
      ) {
        console.warn('[videoApi] create media: invalid_url', { externalUrl: normalizedExternalUrl })
        audit?.(req, 'TASK_CREATED', {
          actor: ownerId,
          result: 'error',
          meta: { error: 'invalid_url' },
        })
        return res.status(400).json({ error: 'invalid_url' })
      }

      const sourceHeader = req.headers['x-event-source'] ?? req.headers['x-task-source'] ?? null
      const source = normalizeSource(req.body?.source ?? sourceHeader)
      if ((req.body?.source != null || sourceHeader != null) && !source) {
        audit?.(req, 'TASK_CREATED', { actor: ownerId, result: 'error', meta: { error: 'invalid_source' } })
        return res.status(400).json({ error: 'invalid_source' })
      }

      let mediaUrl = normalizedExternalUrl
      let storedFileName = ''
      const preferredMediaType =
        req.body.mediaType === 'photo' ? 'photo' : req.body.mediaType === 'video' ? 'video' : undefined

      if (req.file) {
        storedFileName = req.file.filename
        mediaUrl = `/videos/${storedFileName}`
      }

      let mediaType = preferredMediaType
      if (req.file) {
        mediaType = req.file.mimetype.startsWith('image/') ? 'photo' : 'video'
      } else if (!mediaType) {
        mediaType = guessMediaTypeFromUrl(mediaUrl)
      }

      if (!mediaUrl) return res.status(400).json({ error: 'missing_video' })

      const works = await readWorks()
      const work = {
        id: cryptoRandomId(),
        ownerId,
        title: title.trim(),
        description: normalizedDescription.trim(),
        mediaUrl,
        mediaType,
        source: source || null,
        mediaFileName: req.file?.originalname ?? null,
        mediaStorageName: storedFileName || null,
        videoUrl: mediaUrl,
        videoFileName: req.file?.originalname ?? null,
        videoStorageName: storedFileName || null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      }
      works.push(work)
      await writeWorks(works)
      await logBusinessEvent({
        req,
        event: 'TASK_CREATED',
        actor: work.ownerId,
        target: work.id,
        meta: {
          title: work.title ?? null,
          source: work.source ?? 'manual',
          hasFile: Boolean(req.file),
          mediaType: work.mediaType,
        },
      })
      res.status(201).json(work)
    } catch (error) {
      console.error('[videoApi] create media: failed', error)
      audit?.(req, 'TASK_CREATED', {
        actor: typeof req.body?.ownerId === 'string' ? req.body.ownerId : null,
        result: 'error',
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
      next(error)
    }
  })

  router.delete('/api/videos/:id', async (req, res, next) => {
    try {
      const works = await readWorks()
      const index = works.findIndex((work) => work.id === req.params.id)
      if (index === -1) return res.status(404).json({ error: 'not_found' })
      const [removed] = works.splice(index, 1)
      await writeWorks(works)
      const storedName = removed.mediaStorageName ?? removed.videoStorageName
      if (storedName) {
        await fs.unlink(path.join(UPLOADS_DIR, storedName)).catch(() => {})
      }
      await logBusinessEvent({
        req,
        event: 'TASK_DELETED',
        actor: removed.ownerId,
        target: removed.id,
        meta: { title: removed.title ?? null, source: removed.source ?? 'manual' },
      })
      res.status(204).end()
    } catch (error) {
      audit?.(req, 'TASK_DELETED', {
        result: 'error',
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
      next(error)
    }
  })

  router.patch('/api/videos/:id', async (req, res, next) => {
    try {
      const works = await readWorks()
      const index = works.findIndex((work) => work.id === req.params.id)
      if (index === -1) return res.status(404).json({ error: 'not_found' })

      const prev = works[index]
      const title =
        typeof req.body?.title === 'string'
          ? req.body.title.trim()
          : undefined
      const description =
        typeof req.body?.description === 'string'
          ? req.body.description.trim()
          : undefined
      const actionSource = getActionSource(req, prev.source)

      if (title !== undefined && !title) {
        audit?.(req, 'TASK_UPDATED', {
          actor: prev.ownerId,
          target: prev.id,
          result: 'error',
          meta: { error: 'missing_title', source: actionSource },
        })
        return res.status(400).json({ error: 'missing_title' })
      }

      const nextWork = {
        ...prev,
        ...(title !== undefined ? { title } : null),
        ...(description !== undefined ? { description } : null),
      }

      works[index] = nextWork
      await writeWorks(works)

      audit?.(req, 'TASK_UPDATED', {
        actor: prev.ownerId,
        target: prev.id,
        meta: {
          source: actionSource,
          changed: {
            title: title !== undefined,
            description: description !== undefined,
          },
        },
      })
      await logBusinessEvent({
        req,
        event: 'TASK_UPDATED',
        actor: prev.ownerId,
        target: prev.id,
        meta: {
          source: actionSource,
          changed: { title: title !== undefined, description: description !== undefined },
        },
      })
      res.json(normalizeWorkRecord(nextWork))
    } catch (error) {
      audit?.(req, 'TASK_UPDATED', {
        result: 'error',
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
      next(error)
    }
  })

  router.post('/api/videos/:id/complete', async (req, res, next) => {
    try {
      const works = await readWorks()
      const index = works.findIndex((work) => work.id === req.params.id)
      if (index === -1) return res.status(404).json({ error: 'not_found' })

      const work = works[index]
      const actionSource = getActionSource(req, work.source)
      if (!work.completedAt) {
        work.completedAt = new Date().toISOString()
        works[index] = work
        await writeWorks(works)
      }

      await logBusinessEvent({
        req,
        event: 'TASK_COMPLETED',
        actor: work.ownerId,
        target: work.id,
        meta: { title: work.title ?? null, source: actionSource },
      })

      res.json(normalizeWorkRecord(work))
    } catch (error) {
      audit?.(req, 'TASK_COMPLETED', {
        result: 'error',
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
      next(error)
    }
  })

  router.post('/api/translate', async (req, res, next) => {
    try {
      const { q, source, target } = req.body
      const trimmed = typeof q === 'string' ? q.trim() : ''
      if (!trimmed) return res.status(400).json({ error: 'missing_text' })
      if (!['en', 'ru'].includes(source) || !['en', 'ru'].includes(target)) {
        return res.status(400).json({ error: 'invalid_locale' })
      }

      // If translation is unavailable (offline, blocked, old Node without fetch),
      // degrade gracefully to avoid noisy 500s in the browser console.
      if (typeof fetch !== 'function') {
        console.warn('[videoApi] translate: fetch is not available, returning source text')
        return res.json({ translatedText: trimmed })
      }

      const params = new URLSearchParams({
        client: 'gtx',
        sl: source,
        tl: target,
        dt: 't',
        q: trimmed,
      })

      const controller = new AbortController()
      const timeoutMs = 5000
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const translateResponse = await fetch(`https://translate.googleapis.com/translate_a/single?${params.toString()}`, {
          signal: controller.signal,
        })

        if (!translateResponse.ok) {
          const body = await translateResponse.text().catch(() => null)
          console.warn('[videoApi] translate: upstream not ok, returning source text', {
            status: translateResponse.status,
            body: body?.slice?.(0, 200),
          })
          return res.json({ translatedText: trimmed })
        }

        const data = await translateResponse.json().catch(() => null)
        const segments = Array.isArray(data?.[0]) ? data[0] : []
        const translatedText = segments
          .map((segment) => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : ''))
          .join('')

        if (!translatedText) {
          console.warn('[videoApi] translate: upstream empty result, returning source text')
          return res.json({ translatedText: trimmed })
        }

        return res.json({ translatedText })
      } catch (error) {
        console.warn('[videoApi] translate: upstream failure, returning source text', error)
        return res.json({ translatedText: trimmed })
      } finally {
        clearTimeout(timeout)
      }
    } catch (error) {
      console.error('[videoApi] translate error', error)
      next(error)
    }
  })

  router.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      console.error('[videoApi] multer error', { code: error.code, message: error.message })
      if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large' })
      return res.status(400).json({ error: error.message })
    }
    if (error?.message === 'media_only') return res.status(400).json({ error: 'media_only' })
    console.error('[videoApi] server error', error)
    res.status(500).json({ error: 'server_error' })
  })

  return router
}

function cryptoRandomId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

