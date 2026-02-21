import mongoose from 'mongoose'

let ensureIndexesPromise = null
async function ensureIndexes(db) {
  if (ensureIndexesPromise) return ensureIndexesPromise
  ensureIndexesPromise = (async () => {
    const escrows = db.collection('escrows')
    await escrows.createIndex({ taskId: 1, executorId: 1 }, { unique: true })
    await escrows.createIndex({ contractId: 1 }, { unique: true, sparse: true })
    await escrows.createIndex({ customerId: 1, status: 1, createdAt: -1 })
    await escrows.createIndex({ executorId: 1, status: 1, createdAt: -1 })
  })().catch((e) => {
    ensureIndexesPromise = null
    console.warn('[escrowService] ensureIndexes failed', e instanceof Error ? e.message : String(e))
  })
  return ensureIndexesPromise
}

async function safeAdjust(balanceRepo, userId, delta) {
  if (!balanceRepo || typeof balanceRepo.adjust !== 'function') throw new Error('balance_repo_missing')
  return await balanceRepo.adjust(String(userId), delta)
}

async function safeGet(balanceRepo, userId) {
  if (!balanceRepo || typeof balanceRepo.get !== 'function') throw new Error('balance_repo_missing')
  return await balanceRepo.get(String(userId))
}

function round2(n) {
  return Math.round(n * 100) / 100
}

export async function freezeEscrow({
  db,
  balanceRepo,
  taskId,
  contractId = null,
  customerId,
  customerMongoId = null,
  executorId,
  executorMongoId = null,
  amount,
}) {
  await ensureIndexes(db)
  const escrows = db.collection('escrows')

  const amt = typeof amount === 'number' && Number.isFinite(amount) ? round2(amount) : NaN
  if (!Number.isFinite(amt) || amt <= 0) return { ok: true, escrow: null, skipped: true }

  const customerPublicKey = String(customerId)
  const customerMongoKey = customerMongoId ? String(customerMongoId) : null
  const customerBalanceKey = customerMongoKey || customerPublicKey

  const existing = await escrows.findOne({ taskId: String(taskId), executorId: String(executorId) }, { readPreference: 'primary' })
  if (existing) {
    // Best-effort: attach contractId if missing.
    if (contractId && !existing.contractId) {
      await escrows.updateOne({ _id: existing._id }, { $set: { contractId: String(contractId), updatedAt: new Date() } })
    }
    return { ok: true, escrow: existing, already: true }
  }

  // Backward-compatibility: some environments stored balances by publicId (tg_...)
  // while newer auth/economy uses mongoId. If mongoId is present but empty and publicId
  // has funds, migrate public balance to mongoId once.
  let balance = await safeGet(balanceRepo, customerBalanceKey)
  if (customerMongoKey && customerMongoKey !== customerPublicKey) {
    const mongoBal = await safeGet(balanceRepo, customerMongoKey)
    const publicBal = await safeGet(balanceRepo, customerPublicKey)
    if (mongoBal < amt && publicBal > 0 && mongoBal + publicBal >= amt) {
      // Move all public funds to mongo key to keep one source of truth.
      await safeAdjust(balanceRepo, customerMongoKey, publicBal)
      await safeAdjust(balanceRepo, customerPublicKey, -publicBal)
      balance = await safeGet(balanceRepo, customerMongoKey)
    } else {
      balance = mongoBal
    }
  }
  if (balance < amt) return { ok: false, error: 'insufficient_balance', balance, required: amt }

  // Deduct first, then insert escrow; if insert fails, refund.
  await safeAdjust(balanceRepo, customerBalanceKey, -amt)
  const now = new Date()
  try {
    const insertRes = await escrows.insertOne({
      taskId: String(taskId),
      contractId: contractId ? String(contractId) : null,
      customerId: String(customerId),
      customerMongoId: customerMongoId ? String(customerMongoId) : null,
      executorId: String(executorId),
      executorMongoId: executorMongoId ? String(executorMongoId) : null,
      amount: amt,
      status: 'frozen',
      createdAt: now,
      updatedAt: now,
      payouts: null,
    })
    const doc = await escrows.findOne({ _id: insertRes.insertedId }, { readPreference: 'primary' })
    return { ok: true, escrow: doc }
  } catch (e) {
    await safeAdjust(balanceRepo, customerBalanceKey, amt)
    const isDup = e && typeof e === 'object' && 'code' in e && e.code === 11000
    if (isDup) {
      const doc = await escrows.findOne({ taskId: String(taskId), executorId: String(executorId) }, { readPreference: 'primary' })
      return { ok: true, escrow: doc, already: true }
    }
    throw e
  }
}

export async function releaseEscrowToExecutor({ db, balanceRepo, taskId, executorId }) {
  await ensureIndexes(db)
  const escrows = db.collection('escrows')
  const existing = await escrows.findOne({ taskId: String(taskId), executorId: String(executorId) }, { readPreference: 'primary' })
  if (!existing) return { ok: false, error: 'escrow_missing' }
  if (existing.status !== 'frozen') return { ok: true, escrow: existing, already: true }

  const amt = typeof existing.amount === 'number' && Number.isFinite(existing.amount) ? existing.amount : 0
  const executorBalanceKey =
    typeof existing.executorMongoId === 'string' && existing.executorMongoId.trim() ? existing.executorMongoId.trim() : String(executorId)
  if (amt > 0) await safeAdjust(balanceRepo, executorBalanceKey, amt)
  const now = new Date()
  await escrows.updateOne(
    { _id: existing._id },
    { $set: { status: 'released', updatedAt: now, payouts: { executorAmount: amt, customerAmount: 0 } } },
  )
  const doc = await escrows.findOne({ _id: existing._id }, { readPreference: 'primary' })
  return { ok: true, escrow: doc, payout: { executorAmount: amt, customerAmount: 0 } }
}

export async function refundEscrowToCustomer({ db, balanceRepo, taskId, executorId }) {
  await ensureIndexes(db)
  const escrows = db.collection('escrows')
  const existing = await escrows.findOne({ taskId: String(taskId), executorId: String(executorId) }, { readPreference: 'primary' })
  if (!existing) return { ok: false, error: 'escrow_missing' }
  if (existing.status !== 'frozen') return { ok: true, escrow: existing, already: true }

  const amt = typeof existing.amount === 'number' && Number.isFinite(existing.amount) ? existing.amount : 0
  const customerBalanceKey =
    typeof existing.customerMongoId === 'string' && existing.customerMongoId.trim() ? existing.customerMongoId.trim() : String(existing.customerId)
  if (amt > 0) await safeAdjust(balanceRepo, customerBalanceKey, amt)
  const now = new Date()
  await escrows.updateOne(
    { _id: existing._id },
    { $set: { status: 'refunded', updatedAt: now, payouts: { executorAmount: 0, customerAmount: amt } } },
  )
  const doc = await escrows.findOne({ _id: existing._id }, { readPreference: 'primary' })
  return { ok: true, escrow: doc, payout: { executorAmount: 0, customerAmount: amt } }
}

export async function splitEscrow({ db, balanceRepo, taskId, executorId, executorAmount, customerAmount }) {
  await ensureIndexes(db)
  const escrows = db.collection('escrows')
  const existing = await escrows.findOne({ taskId: String(taskId), executorId: String(executorId) }, { readPreference: 'primary' })
  if (!existing) return { ok: false, error: 'escrow_missing' }
  if (existing.status !== 'frozen') return { ok: true, escrow: existing, already: true }

  const ex = typeof executorAmount === 'number' && Number.isFinite(executorAmount) ? round2(executorAmount) : NaN
  const cu = typeof customerAmount === 'number' && Number.isFinite(customerAmount) ? round2(customerAmount) : NaN
  if (!Number.isFinite(ex) || ex < 0) return { ok: false, error: 'invalid_executorAmount' }
  if (!Number.isFinite(cu) || cu < 0) return { ok: false, error: 'invalid_customerAmount' }

  const amt = typeof existing.amount === 'number' && Number.isFinite(existing.amount) ? round2(existing.amount) : 0
  if (round2(ex + cu) != amt) return { ok: false, error: 'amount_mismatch' }

  const customerBalanceKey =
    typeof existing.customerMongoId === 'string' && existing.customerMongoId.trim() ? existing.customerMongoId.trim() : String(existing.customerId)
  const executorBalanceKey =
    typeof existing.executorMongoId === 'string' && existing.executorMongoId.trim() ? existing.executorMongoId.trim() : String(executorId)
  if (ex > 0) await safeAdjust(balanceRepo, executorBalanceKey, ex)
  if (cu > 0) await safeAdjust(balanceRepo, customerBalanceKey, cu)
  const now = new Date()
  await escrows.updateOne(
    { _id: existing._id },
    { $set: { status: 'split', updatedAt: now, payouts: { executorAmount: ex, customerAmount: cu } } },
  )
  const doc = await escrows.findOne({ _id: existing._id }, { readPreference: 'primary' })
  return { ok: true, escrow: doc, payout: { executorAmount: ex, customerAmount: cu } }
}

export function escrowForTaskExecutorQuery(taskId, executorId) {
  return { taskId: String(taskId), executorId: String(executorId) }
}

