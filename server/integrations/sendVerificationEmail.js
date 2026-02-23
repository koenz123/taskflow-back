import crypto from 'node:crypto'
import { getResendClient } from './resend.js'

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

async function trySendViaResend({ to, subject, text, html }) {
  const resend = getResendClient()
  if (!resend) return { delivered: false, reason: 'resend_not_configured' }

  const from = String(process.env.RESEND_FROM || 'Nativki <noreply@nativki.ru>').trim()
  const shouldLog = String(process.env.RESEND_LOG || '').trim() === '1'

  try {
    const response = await resend.emails.send({
      from,
      to,
      subject,
      text,
      html,
    })
    if (shouldLog) console.log('RESEND RESPONSE:', response)
    return { delivered: true, channel: 'resend' }
  } catch (err) {
    console.error('RESEND ERROR:', err)
    const e = err instanceof Error ? err : new Error(String(err))
    return { delivered: false, reason: 'resend_send_failed', error: e.message }
  }
}

async function trySendViaSmtp({ to, subject, text, html }) {
  // Optional dependency. If not configured, we fallback to console.
  let nodemailer = null
  try {
    const mod = await import('nodemailer')
    nodemailer = mod?.default ?? mod
  } catch {
    nodemailer = null
  }

  const SMTP_HOST = process.env.SMTP_HOST
  const SMTP_PORT = process.env.SMTP_PORT
  const SMTP_USER = process.env.SMTP_USER
  const SMTP_PASS = process.env.SMTP_PASS
  const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER

  if (!nodemailer) return { delivered: false, reason: 'nodemailer_missing' }
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
    return { delivered: false, reason: 'smtp_not_configured' }
  }

  const port = Number(SMTP_PORT)
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number.isFinite(port) ? port : 587,
    secure: Number.isFinite(port) ? port === 465 : false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  })

  try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to,
      subject,
      text,
      html,
    })
    return { delivered: true, channel: 'smtp' }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    return { delivered: false, reason: 'smtp_send_failed', error: e.message }
  }
}

function hashCode({ code, token }) {
  // Token is long random, used as salt to avoid storing plain code.
  return crypto.createHash('sha256').update(`${token}:${code}`).digest('hex')
}

export function generateVerificationCode() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
}

export function buildVerificationData({ token, code, ttlMs }) {
  const nowMs = Date.now()
  const expiresAt = new Date(nowMs + ttlMs).toISOString()
  return {
    codeHash: hashCode({ code, token }),
    expiresAt,
  }
}

export function verifyCode({ token, code, expectedHash }) {
  const got = hashCode({ code, token })
  try {
    return crypto.timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(String(expectedHash || ''), 'utf8'))
  } catch {
    return false
  }
}

function normalizeLocale(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (raw.startsWith('en')) return 'en'
  return 'ru'
}

function appUrl() {
  return String(process.env.FRONTEND_BASE_URL || process.env.PUBLIC_BASE_URL || 'https://nativki.ru').trim()
}

function buildEmailContent({ kind, locale, code, ttlMinutes }) {
  const loc = normalizeLocale(locale)
  const c = String(code)
  const url = appUrl()

  if (kind === 'reset_password') {
    if (loc === 'en') {
      const subject = 'Your TaskFlow password reset code'
      const text = [
        'Hi,',
        'We received a request to reset your TaskFlow password.',
        '',
        'Your code:',
        c,
        '',
        'Enter it on the “Forgot password” page to set a new password.',
        `This code expires in ${ttlMinutes} minutes.`,
        '',
        'If you didn’t request this, you can ignore this email.',
        'TaskFlow Team',
        url,
      ].join('\n')
      const html = `
        <div style="font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; line-height: 1.45; color: #111;">
          <p style="margin:0 0 12px;">Hi,</p>
          <p style="margin:0 0 12px;">We received a request to reset your TaskFlow password.</p>
          <p style="margin:16px 0 6px;">Your code:</p>
          <div style="font-size:28px;font-weight:800;letter-spacing:6px;margin:0 0 16px;">${escapeHtml(c)}</div>
          <p style="margin:0 0 12px;">Enter it on the “Forgot password” page to set a new password.</p>
          <p style="margin:0 0 12px;color:#555;">This code expires in ${ttlMinutes} minutes.</p>
          <p style="margin:16px 0 0;color:#777;">If you didn’t request this, you can ignore this email.</p>
          <p style="margin:12px 0 0;color:#777;">TaskFlow Team<br/>${escapeHtml(url)}</p>
        </div>
      `
      return { subject, text, html }
    }

    const subject = 'Код для сброса пароля TaskFlow'
    const text = [
      'Здравствуйте!',
      'Мы получили запрос на сброс пароля для вашего аккаунта TaskFlow.',
      '',
      'Ваш код подтверждения:',
      c,
      '',
      'Введите этот код на странице «Забыли пароль?» и задайте новый пароль.',
      `Код действует ${ttlMinutes} минут.`,
      '',
      'Если вы не запрашивали сброс пароля — просто проигнорируйте это письмо, ничего не изменится.',
      'С уважением,',
      'Команда TaskFlow',
      url,
    ].join('\n')
    const html = `
      <div style="font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; line-height: 1.45; color: #111;">
        <p style="margin:0 0 12px;">Здравствуйте!</p>
        <p style="margin:0 0 12px;">Мы получили запрос на сброс пароля для вашего аккаунта TaskFlow.</p>
        <p style="margin:16px 0 6px;">Ваш код подтверждения:</p>
        <div style="font-size:28px;font-weight:800;letter-spacing:6px;margin:0 0 16px;">${escapeHtml(c)}</div>
        <p style="margin:0 0 12px;">Введите этот код на странице «Забыли пароль?» и задайте новый пароль.</p>
        <p style="margin:0 0 12px;color:#555;">Код действует ${ttlMinutes} минут.</p>
        <p style="margin:16px 0 0;color:#777;">Если вы не запрашивали сброс пароля — просто проигнорируйте это письмо, ничего не изменится.</p>
        <p style="margin:12px 0 0;color:#777;">С уважением,<br/>Команда TaskFlow<br/>${escapeHtml(url)}</p>
      </div>
    `
    return { subject, text, html }
  }

  // Default: registration verification code
  if (loc === 'en') {
    const subject = 'Your TaskFlow registration code'
    const text = [
      'Hi,',
      'You started registration in TaskFlow. To confirm your email and complete account creation, enter the code below:',
      c,
      '',
      'Enter this code on the registration confirmation page.',
      `This code expires in ${ttlMinutes} minutes.`,
      '',
      'If you didn’t register in TaskFlow — you can ignore this email.',
      'TaskFlow Team',
      url,
    ].join('\n')
    const html = `
      <div style="font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; line-height: 1.45; color: #111;">
        <p style="margin:0 0 12px;">Hi,</p>
        <p style="margin:0 0 12px;">You started registration in TaskFlow. To confirm your email and complete account creation, enter the code below:</p>
        <div style="font-size:28px;font-weight:800;letter-spacing:6px;margin:16px 0 16px;">${escapeHtml(c)}</div>
        <p style="margin:0 0 12px;">Enter this code on the registration confirmation page.</p>
        <p style="margin:0 0 12px;color:#555;">This code expires in ${ttlMinutes} minutes.</p>
        <p style="margin:16px 0 0;color:#777;">If you didn’t register in TaskFlow — you can ignore this email.</p>
        <p style="margin:12px 0 0;color:#777;">TaskFlow Team<br/>${escapeHtml(url)}</p>
      </div>
    `
    return { subject, text, html }
  }

  const subject = 'Код подтверждения регистрации TaskFlow'
  const text = [
    'Здравствуйте!',
    'Вы начали регистрацию в TaskFlow. Чтобы подтвердить email и завершить создание аккаунта, введите код ниже:',
    c,
    '',
    'Введите этот код на странице подтверждения регистрации.',
    `Код действует ${ttlMinutes} минут.`,
    '',
    'Если вы не регистрировались в TaskFlow — просто проигнорируйте это письмо.',
    'С уважением,',
    'Команда TaskFlow',
    url,
  ].join('\n')
  const html = `
    <div style="font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; line-height: 1.45; color: #111;">
      <p style="margin:0 0 12px;">Здравствуйте!</p>
      <p style="margin:0 0 12px;">Вы начали регистрацию в TaskFlow. Чтобы подтвердить email и завершить создание аккаунта, введите код ниже:</p>
      <div style="font-size:28px;font-weight:800;letter-spacing:6px;margin:16px 0 16px;">${escapeHtml(c)}</div>
      <p style="margin:0 0 12px;">Введите этот код на странице подтверждения регистрации.</p>
      <p style="margin:0 0 12px;color:#555;">Код действует ${ttlMinutes} минут.</p>
      <p style="margin:16px 0 0;color:#777;">Если вы не регистрировались в TaskFlow — просто проигнорируйте это письмо.</p>
      <p style="margin:12px 0 0;color:#777;">С уважением,<br/>Команда TaskFlow<br/>${escapeHtml(url)}</p>
    </div>
  `
  return { subject, text, html }
}

export default async function sendVerificationEmail(
  email,
  { code, ttlMinutes = 10, kind = 'register', locale = 'ru', verifyUrl: _verifyUrl = null } = {},
) {
  const content = buildEmailContent({ kind, locale, code, ttlMinutes })

  // Prefer Resend if configured, else SMTP, else console.
  const viaResend = await trySendViaResend({ to: email, subject: content.subject, text: content.text, html: content.html })
  if (viaResend.delivered) return viaResend

  const viaSmtp = await trySendViaSmtp({ to: email, subject: content.subject, text: content.text, html: content.html })
  if (viaSmtp.delivered) return viaSmtp

  return { delivered: false, reason: 'not_configured', meta: { resend: viaResend, smtp: viaSmtp } }
}

