import express from 'express'
import mongoose from 'mongoose'
import { tryResolveAuthUser } from '../auth/authSession.js'
import { requireAuth } from '../auth/auth.js'

const MIN_WITHDRAWAL_RUB = 5000

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}

function getAuth(r) {
  const userMongoId = String(r.userId)
  const role = typeof r.user?.role === 'string' ? r.user.role : 'pending'
  return { userMongoId, role }
}

const LEGAL_STATUSES = ['individual', 'self_employed', 'legal_entity']

/** Читает поле из объекта: сначала camelCase, затем snake_case (для совместимости с фронтом). */
function pick(obj, camelKey, snakeKey = camelKey.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '')) {
  if (!obj || typeof obj !== 'object') return undefined
  const v = obj[camelKey]
  if (v !== undefined && v !== null) return v
  return obj[snakeKey]
}

const DIGITS_11 = /^\d{11}$/
const DIGITS_4 = /^\d{4}$/
const DIGITS_6 = /^\d{6}$/
const DIGITS_20 = /^\d{20}$/

/** Валидация и нормализация snils и паспортных полей из body. */
function validatePayoutExtra(body) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '')
  const snilsRaw = pick(body, 'snils')
  const snils = str(snilsRaw)
  if (snils && !DIGITS_11.test(snils)) return { ok: false, error: 'invalid_snils', expected: '11 digits' }

  const passportSeriesRaw = pick(body, 'passportSeries', 'passport_series')
  const passportSeries = str(passportSeriesRaw)
  if (passportSeries && !DIGITS_4.test(passportSeries)) return { ok: false, error: 'invalid_passportSeries', expected: '4 digits' }

  const passportNumberRaw = pick(body, 'passportNumber', 'passport_number')
  const passportNumber = str(passportNumberRaw)
  if (passportNumber && !DIGITS_6.test(passportNumber)) return { ok: false, error: 'invalid_passportNumber', expected: '6 digits' }

  const passportIssuedBy = str(pick(body, 'passportIssuedBy', 'passport_issued_by'))
  const passportIssueDate = str(pick(body, 'passportIssueDate', 'passport_issue_date'))

  return {
    ok: true,
    extra: {
      snils: snils || undefined,
      passportSeries: passportSeries || undefined,
      passportNumber: passportNumber || undefined,
      passportIssuedBy: passportIssuedBy || undefined,
      passportIssueDate: passportIssueDate || undefined,
    },
  }
}

function validateBankDetails(legalStatus, bankDetails) {
  if (!bankDetails || typeof bankDetails !== 'object') return { ok: false, error: 'missing_bankDetails' }
  const d = bankDetails
  const str = (v) => (typeof v === 'string' ? v.trim() : '')
  const s = (camel, snake) => str(pick(d, camel, snake))

  const correspondentAccount = s('correspondentAccount', 'correspondent_account')
  if (correspondentAccount && !DIGITS_20.test(correspondentAccount)) {
    return { ok: false, error: 'invalid_correspondentAccount', expected: '20 digits' }
  }

  if (legalStatus === 'individual') {
    const fullName = s('fullName', 'full_name')
    const accountNumber = s('accountNumber', 'account_number')
    const bik = str(d.bik)
    const bankName = s('bankName', 'bank_name')
    const cardNumber = s('cardNumber', 'card_number')
    if (!fullName) return { ok: false, error: 'missing_fullName' }
    if (!accountNumber) return { ok: false, error: 'missing_accountNumber' }
    if (!bik) return { ok: false, error: 'missing_bik' }
    if (!bankName) return { ok: false, error: 'missing_bankName' }
    return {
      ok: true,
      bankDetails: { fullName, accountNumber, bik, bankName, correspondentAccount: correspondentAccount || undefined, cardNumber: cardNumber || undefined },
    }
  }
  if (legalStatus === 'self_employed') {
    const fullName = s('fullName', 'full_name')
    const inn = str(d.inn)
    const accountNumber = s('accountNumber', 'account_number')
    const bik = str(d.bik)
    const bankName = s('bankName', 'bank_name')
    const cardNumber = s('cardNumber', 'card_number')
    if (!fullName) return { ok: false, error: 'missing_fullName' }
    if (!inn) return { ok: false, error: 'missing_inn' }
    if (!accountNumber) return { ok: false, error: 'missing_accountNumber' }
    if (!bik) return { ok: false, error: 'missing_bik' }
    if (!bankName) return { ok: false, error: 'missing_bankName' }
    return {
      ok: true,
      bankDetails: { fullName, inn, accountNumber, bik, bankName, correspondentAccount: correspondentAccount || undefined, cardNumber: cardNumber || undefined },
    }
  }
  if (legalStatus === 'legal_entity') {
    const companyName = s('companyName', 'company_name')
    const inn = str(d.inn)
    const accountNumber = s('accountNumber', 'account_number')
    const bik = str(d.bik)
    const bankName = s('bankName', 'bank_name')
    const kpp = str(d.kpp)
    if (!companyName) return { ok: false, error: 'missing_companyName' }
    if (!inn) return { ok: false, error: 'missing_inn' }
    if (!accountNumber) return { ok: false, error: 'missing_accountNumber' }
    if (!bik) return { ok: false, error: 'missing_bik' }
    if (!bankName) return { ok: false, error: 'missing_bankName' }
    return {
      ok: true,
      bankDetails: { companyName, inn, accountNumber, bik, bankName, correspondentAccount: correspondentAccount || undefined, kpp: kpp || undefined },
    }
  }
  return { ok: false, error: 'invalid_legalStatus' }
}

function toPayoutProfileDto(doc) {
  const p = doc?.payoutProfile
  const bd = p?.bankDetails && typeof p.bankDetails === 'object' ? p.bankDetails : null
  if (!p) {
    return {
      legalStatus: null,
      status: null,
      fullName: null,
      inn: null,
      snils: null,
      passportSeries: null,
      passportNumber: null,
      passportIssuedBy: null,
      passportIssueDate: null,
      bankDetails: null,
    }
  }
  return {
    legalStatus: p.legalStatus ?? null,
    status: p.status ?? null,
    fullName: bd?.fullName ?? null,
    inn: bd?.inn ?? null,
    snils: p.snils ?? null,
    passportSeries: p.passportSeries ?? null,
    passportNumber: p.passportNumber ?? null,
    passportIssuedBy: p.passportIssuedBy ?? null,
    passportIssueDate: p.passportIssueDate ?? null,
    bankDetails: bd,
  }
}

export function createPayoutApi({ balanceRepo }) {
  const router = express.Router()
  router.use(express.json({ limit: '64kb' }))

  // GET /api/payout-profile — текущий профиль выплат (executor или customer)
  router.get(
    '/api/payout-profile',
    requireAuth,
    asyncHandler(async (req, res) => {
      const r = await tryResolveAuthUser(req)
      const { userMongoId, role } = getAuth(r)
      if (role !== 'executor' && role !== 'customer') return res.status(403).json({ error: 'forbidden' })

      const db = mongoose.connection.db
      if (!db) return res.status(500).json({ error: 'mongo_not_available' })
      const users = db.collection('users')
      let oid
      try {
        oid = new mongoose.Types.ObjectId(userMongoId)
      } catch {
        return res.status(400).json({ error: 'bad_user_id' })
      }
      const user = await users.findOne({ _id: oid }, { projection: { payoutProfile: 1 }, readPreference: 'primary' })
      return res.json(toPayoutProfileDto(user))
    }),
  )

  // POST /api/payout-profile — сохранить профиль, status = pending_verification (executor или customer)
  router.post(
    '/api/payout-profile',
    requireAuth,
    asyncHandler(async (req, res) => {
      const r = await tryResolveAuthUser(req)
      const { userMongoId, role } = getAuth(r)
      if (role !== 'executor' && role !== 'customer') return res.status(403).json({ error: 'forbidden' })

      const legalStatusRaw = pick(req.body, 'legalStatus', 'legal_status')
      const legalStatus = typeof legalStatusRaw === 'string' ? legalStatusRaw.trim() : ''
      if (!LEGAL_STATUSES.includes(legalStatus)) {
        return res.status(400).json({ error: 'invalid_legalStatus', allowed: LEGAL_STATUSES })
      }
      const bankDetailsRaw = req.body?.bankDetails ?? req.body?.bank_details
      const validation = validateBankDetails(legalStatus, bankDetailsRaw)
      if (!validation.ok) return res.status(400).json({ error: validation.error })

      const extraValidation = validatePayoutExtra(req.body)
      if (!extraValidation.ok) return res.status(400).json({ error: extraValidation.error, expected: extraValidation.expected })

      const db = mongoose.connection.db
      if (!db) return res.status(500).json({ error: 'mongo_not_available' })
      const users = db.collection('users')
      let oid
      try {
        oid = new mongoose.Types.ObjectId(userMongoId)
      } catch {
        return res.status(400).json({ error: 'bad_user_id' })
      }
      const now = new Date()
      const payoutProfile = {
        legalStatus,
        status: 'pending_verification',
        bankDetails: validation.bankDetails,
        ...extraValidation.extra,
        updatedAt: now.toISOString(),
      }
      await users.updateOne(
        { _id: oid },
        { $set: { payoutProfile, updatedAt: now } },
      )
      const user = await users.findOne({ _id: oid }, { projection: { payoutProfile: 1 }, readPreference: 'primary' })
      return res.json(toPayoutProfileDto(user))
    }),
  )

  // GET /api/withdrawals — список заявок на вывод текущего пользователя (executor или customer)
  router.get(
    '/api/withdrawals',
    requireAuth,
    asyncHandler(async (req, res) => {
      const r = await tryResolveAuthUser(req)
      const { userMongoId, role } = getAuth(r)
      if (role !== 'executor' && role !== 'customer') return res.status(403).json({ error: 'forbidden' })

      const db = mongoose.connection.db
      if (!db) return res.status(500).json({ error: 'mongo_not_available' })
      const withdrawals = db.collection('withdrawalRequests')
      const list = await withdrawals
        .find({ userId: userMongoId })
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray()
      return res.json(
        list.map((d) => ({
          id: String(d._id),
          userId: d.userId,
          amount: d.amount,
          legalStatus: d.legalStatus ?? null,
          status: d.status ?? null,
          createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
          updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
        })),
      )
    }),
  )

  // POST /api/withdraw — заявка на вывод (executor или customer, verified profile, balance >= 5000 RUB)
  router.post(
    '/api/withdraw',
    requireAuth,
    asyncHandler(async (req, res) => {
      const r = await tryResolveAuthUser(req)
      const { userMongoId, role } = getAuth(r)
      if (role !== 'executor' && role !== 'customer') return res.status(403).json({ error: 'forbidden' })

      const amount = typeof req.body?.amount === 'number' ? req.body.amount : Number(req.body?.amount)
      if (!Number.isFinite(amount) || amount < MIN_WITHDRAWAL_RUB) {
        return res.status(400).json({ error: 'invalid_amount', minAmount: MIN_WITHDRAWAL_RUB })
      }

      const db = mongoose.connection.db
      if (!db) return res.status(500).json({ error: 'mongo_not_available' })
      const users = db.collection('users')
      const withdrawals = db.collection('withdrawalRequests')
      let oid
      try {
        oid = new mongoose.Types.ObjectId(userMongoId)
      } catch {
        return res.status(400).json({ error: 'bad_user_id' })
      }
      const user = await users.findOne({ _id: oid }, { projection: { payoutProfile: 1 }, readPreference: 'primary' })
      const profile = user?.payoutProfile
      if (!profile || profile.status !== 'verified') {
        return res.status(403).json({ error: 'payout_profile_not_verified' })
      }

      const balanceRub = await balanceRepo.get(req.user.id)
      if (balanceRub < amount) {
        return res.status(400).json({ error: 'insufficient_balance', balance: balanceRub, required: amount })
      }

      const now = new Date()
      const doc = {
        userId: userMongoId,
        amount: Math.round(amount),
        legalStatus: profile.legalStatus ?? null,
        bankDetailsSnapshot: profile.bankDetails && typeof profile.bankDetails === 'object' ? profile.bankDetails : null,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      }
      const insertRes = await withdrawals.insertOne(doc)
      await balanceRepo.adjust(req.user.id, -amount)

      const created = await withdrawals.findOne({ _id: insertRes.insertedId }, { readPreference: 'primary' })
      return res.status(201).json({
        id: String(created._id),
        userId: created.userId,
        amount: created.amount,
        legalStatus: created.legalStatus,
        status: created.status,
        createdAt: created.createdAt ? new Date(created.createdAt).toISOString() : null,
      })
    }),
  )

  return router
}
