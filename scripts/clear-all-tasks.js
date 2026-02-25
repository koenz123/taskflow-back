#!/usr/bin/env node
/**
 * One-off script: удаляет все задания и связанные данные из MongoDB.
 * Подключается по MONGODB_URI из .env в корне проекта.
 *
 * Запуск (из корня репозитория):
 *   node scripts/clear-all-tasks.js
 *
 * Или на сервере с указанием URI:
 *   MONGODB_URI="mongodb://..." node scripts/clear-all-tasks.js
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import mongoose from 'mongoose'

const __dirname = path.dirname(pathToFileURL(import.meta.url).pathname)
const rootDir = path.resolve(__dirname, '..')

function loadEnv(filePath) {
  const env = readFileSync(filePath, 'utf-8')
  for (const line of env.split(/\r?\n/)) {
    let s = line.replace(/^\s*export\s+/i, '').trim()
    if (!s) continue
    if (s.startsWith('#')) continue
    const idx = s.indexOf('=')
    if (idx <= 0) continue
    const key = s.slice(0, idx).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (process.env[key]) continue
    let val = s.slice(idx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    process.env[key] = val
  }
}

// Load .env from cwd or project root
for (const dir of [process.cwd(), rootDir]) {
  const envPath = path.join(dir, '.env')
  try {
    loadEnv(envPath)
    break
  } catch {
    // try next
  }
}

const uri = process.env.MONGODB_URI || process.env.DATABASE_URL
if (!uri) {
  console.error('MONGODB_URI not set. Tried .env in:', process.cwd(), 'and', rootDir)
  console.error('Run: MONGODB_URI="mongodb://..." node scripts/clear-all-tasks.js')
  process.exit(1)
}

async function main() {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 })
  const db = mongoose.connection.db
  if (!db) {
    console.error('No db')
    process.exit(1)
  }

  const tasks = db.collection('tasks')
  const contracts = db.collection('contracts')
  const disputes = db.collection('disputes')
  const disputeMessages = db.collection('disputeMessages')
  const applications = db.collection('applications')
  const assignments = db.collection('assignments')
  const submissions = db.collection('submissions')
  const escrows = db.collection('escrows')

  const taskList = await tasks.find({}, { projection: { _id: 1 } }).toArray()
  const taskIds = taskList.map((t) => String(t._id))
  const contractList = await contracts.find({ taskId: { $in: taskIds } }, { projection: { _id: 1 } }).toArray()
  const contractIds = contractList.map((c) => String(c._id))
  const disputeList = await disputes.find({ contractId: { $in: contractIds } }, { projection: { _id: 1 } }).toArray()
  const disputeIds = disputeList.map((d) => String(d._id))

  let r
  r = await disputeMessages.deleteMany({ disputeId: { $in: disputeIds } })
  const deletedDisputeMessages = r.deletedCount ?? 0
  r = await disputes.deleteMany({ contractId: { $in: contractIds } })
  const deletedDisputes = r.deletedCount ?? 0
  r = await submissions.deleteMany({ contractId: { $in: contractIds } })
  const deletedSubmissions = r.deletedCount ?? 0
  r = await applications.deleteMany({ taskId: { $in: taskIds } })
  const deletedApplications = r.deletedCount ?? 0
  r = await assignments.deleteMany({ taskId: { $in: taskIds } })
  const deletedAssignments = r.deletedCount ?? 0
  r = await contracts.deleteMany({ taskId: { $in: taskIds } })
  const deletedContracts = r.deletedCount ?? 0
  r = await escrows.deleteMany({ taskId: { $in: taskIds } })
  const deletedEscrows = r.deletedCount ?? 0
  r = await tasks.deleteMany({})
  const deletedTasks = r.deletedCount ?? 0

  console.log(JSON.stringify({
    ok: true,
    deletedTasks,
    deletedApplications,
    deletedContracts,
    deletedDisputes,
    deletedDisputeMessages,
    deletedAssignments,
    deletedSubmissions,
    deletedEscrows,
  }, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => mongoose.disconnect().catch(() => {}))
