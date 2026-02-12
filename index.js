import { fileURLToPath } from 'node:url'
import path from 'node:path'
import express from 'express'
import cors from 'cors'
import { createVideoApi } from './videoApi.js'
import { createAuthApi } from './authApi.js'

const PORT = process.env.PORT || 4000
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.join(__dirname, 'data')
const UPLOADS_DIR = path.join(__dirname, 'uploads', 'videos')
const WORKS_FILE = path.join(DATA_DIR, 'works.json')

const app = express()
app.use(cors({ origin: true }))

app.use(
  createVideoApi({
    worksFile: WORKS_FILE,
    uploadsDir: UPLOADS_DIR,
    maxFileBytes: 2 * 1024 * 1024 * 1024,
  }),
)

app.use(
  createAuthApi({
    dataDir: DATA_DIR,
    appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:5173',
  }),
)

app.listen(PORT, () => {
  console.log(`Video server listening on ${PORT}`)
})
