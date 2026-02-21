import path from 'node:path'
import { promises as fs } from 'node:fs'
import express from 'express'
import multer from 'multer'

function trimTrailingSlash(s) {
  return typeof s === 'string' ? s.replace(/\/+$/, '') : ''
}

function buildPublicBaseUrl(req) {
  const envBase = trimTrailingSlash(process.env.PUBLIC_BASE_URL || '')
  if (envBase) return envBase
  const host = req.get('host')
  if (!host) return ''
  return `${req.protocol}://${host}`
}

function guessMediaType(mimeType) {
  if (typeof mimeType !== 'string') return 'file'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('image/')) return 'image'
  return 'file'
}

export function createUploadsApi({ uploadsDir, maxFileBytes = 2 * 1024 * 1024 * 1024 } = {}) {
  const router = express.Router()

  const UPLOADS_DIR = uploadsDir
  if (!UPLOADS_DIR) {
    throw new Error('createUploadsApi: uploadsDir is required')
  }

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '')
      const safeName = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
      cb(null, safeName)
    },
  })

  const upload = multer({
    storage,
    limits: { fileSize: maxFileBytes },
    fileFilter: (_req, file, cb) => {
      // Current product need: video exchange + customer references.
      // Allow common media types; keep a tight default for safety.
      if (!file.mimetype.startsWith('video/') && !file.mimetype.startsWith('image/')) {
        return cb(new Error('media_only'))
      }
      cb(null, true)
    },
  })

  const ready = fs.mkdir(UPLOADS_DIR, { recursive: true }).catch((e) => {
    console.error('[uploadsApi] ensure dir failed', e)
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

  // Public static URLs (frontend stores them as https links).
  router.use('/uploads', express.static(UPLOADS_DIR))

  // Upload a single media file. Returns absolute url for clients.
  router.post('/api/uploads', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'missing_file' })
    const publicPath = `/uploads/${req.file.filename}`
    const baseUrl = buildPublicBaseUrl(req)
    const url = baseUrl ? `${baseUrl}${publicPath}` : publicPath
    return res.status(201).json({
      url,
      path: publicPath,
      storageName: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      mediaType: guessMediaType(req.file.mimetype),
      size: req.file.size,
    })
  })

  router.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large' })
      return res.status(400).json({ error: error.message })
    }
    if (error?.message === 'media_only') return res.status(400).json({ error: 'media_only' })
    console.error('[uploadsApi] server error', error)
    return res.status(500).json({ error: 'server_error' })
  })

  return router
}

