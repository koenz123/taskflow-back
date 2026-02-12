import path from 'node:path'
import { promises as fs } from 'node:fs'
import express from 'express'
import multer from 'multer'

export function createVideoApi({ worksFile, uploadsDir, maxFileBytes }) {
  const router = express()

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
      console.log('[videoApi] list works: start', { userId: req.params.userId })
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
      console.log('[videoApi] list works: ok', {
        userId: req.params.userId,
        count: filtered.length,
        changed,
      })
      res.json(filtered)
    } catch (error) {
      console.error('[videoApi] list works: failed', error)
      next(error)
    }
  })

  router.post('/api/videos', upload.single('file'), async (req, res, next) => {
    try {
      console.log('[videoApi] create media: start', {
        hasFile: Boolean(req.file),
        contentType: req.headers['content-type'],
        contentLength: req.headers['content-length'],
      })
      const { ownerId, title, description, externalUrl } = req.body
      if (!ownerId || !title) {
        console.warn('[videoApi] create media: missing_fields', {
          ownerId: Boolean(ownerId),
          title: Boolean(title),
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
        return res.status(400).json({ error: 'invalid_url' })
      }

      let mediaUrl = normalizedExternalUrl
      let storedFileName = ''
      const preferredMediaType =
        req.body.mediaType === 'photo' ? 'photo' : req.body.mediaType === 'video' ? 'video' : undefined

      if (req.file) {
        storedFileName = req.file.filename
        console.log('[videoApi] create media: file stored', {
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
          size: req.file.size,
          storedFileName,
        })
        mediaUrl = `/videos/${storedFileName}`
      }

      let mediaType = preferredMediaType
      if (req.file) {
        mediaType = req.file.mimetype.startsWith('image/') ? 'photo' : 'video'
      } else if (!mediaType) {
        mediaType = guessMediaTypeFromUrl(mediaUrl)
      }

      if (!mediaUrl) return res.status(400).json({ error: 'missing_video' })

      console.log('[videoApi] create media: writing work record', {
        ownerId,
        titleLength: String(title).length,
        descriptionLength: String(normalizedDescription).length,
      })
      const works = await readWorks()
      const work = {
        id: cryptoRandomId(),
        ownerId,
        title: title.trim(),
        description: normalizedDescription.trim(),
        mediaUrl,
        mediaType,
        mediaFileName: req.file?.originalname ?? null,
        mediaStorageName: storedFileName || null,
        videoUrl: mediaUrl,
        videoFileName: req.file?.originalname ?? null,
        videoStorageName: storedFileName || null,
        createdAt: new Date().toISOString(),
      }
      works.push(work)
      await writeWorks(works)
      console.log('[videoApi] create media: ok', { id: work.id, ownerId: work.ownerId, mediaUrl: work.mediaUrl })
      res.status(201).json(work)
    } catch (error) {
      console.error('[videoApi] create media: failed', error)
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
      res.status(204).end()
    } catch (error) {
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

      if (title !== undefined && !title) {
        return res.status(400).json({ error: 'missing_title' })
      }

      const nextWork = {
        ...prev,
        ...(title !== undefined ? { title } : null),
        ...(description !== undefined ? { description } : null),
      }

      works[index] = nextWork
      await writeWorks(works)

      res.json(normalizeWorkRecord(nextWork))
    } catch (error) {
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

