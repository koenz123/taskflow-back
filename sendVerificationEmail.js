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

export default async function sendVerificationEmail(email, { code, verifyUrl = null, ttlMinutes = 10 } = {}) {
  const safeCode = escapeHtml(code)

  const subject = 'Код подтверждения'
  const textLines = [
    'Ваш код подтверждения:',
    String(code),
    '',
    `Код действует ${ttlMinutes} минут.`,
  ]
  const text = textLines.join('\n')

  const template = `
<div style="background:#f6f7fb;padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

  <div style="max-width:520px;margin:auto;background:white;border-radius:16px;padding:40px 32px;box-shadow:0 8px 24px rgba(0,0,0,0.05);text-align:center;">

    <div style="font-size:22px;font-weight:700;margin-bottom:24px;color:#111;">
      Nativki
    </div>

    <h2 style="margin:0 0 12px;font-size:22px;color:#111;">
      Подтвердите вашу почту
    </h2>

    <p style="margin:0 0 28px;color:#555;font-size:15px;">
      Введите этот код в приложении
    </p>

    <div style="
      font-size:36px;
      letter-spacing:8px;
      font-weight:700;
      color:#111;
      background:#f3f4f8;
      padding:16px 24px;
      border-radius:12px;
      display:inline-block;
      margin-bottom:24px;
    ">
      ${safeCode}
    </div>

    <p style="margin:0 0 24px;color:#888;font-size:13px;">
      Код действует ${ttlMinutes} минут
    </p>

    <p style="margin:0;color:#aaa;font-size:12px;">
      Если вы не регистрировались — просто проигнорируйте письмо
    </p>

  </div>

</div>
`

  // Prefer Resend if configured, else SMTP, else console.
  const viaResend = await trySendViaResend({ to: email, subject, text, html: template })
  if (viaResend.delivered) return viaResend

  const viaSmtp = await trySendViaSmtp({ to: email, subject, text, html: template })
  if (viaSmtp.delivered) return viaSmtp

  return { delivered: false, reason: 'not_configured', meta: { resend: viaResend, smtp: viaSmtp } }
}

