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

  try {
    await resend.emails.send({
      from,
      to,
      subject,
      text,
      html,
    })
    return { delivered: true, channel: 'resend' }
  } catch (err) {
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
  const safeVerifyUrl = verifyUrl ? escapeHtml(verifyUrl) : null

  const subject = 'Код подтверждения'
  const textLines = [
    'Ваш код подтверждения:',
    String(code),
    '',
    `Код действует ${ttlMinutes} минут.`,
  ]
  if (verifyUrl) {
    textLines.push('', 'Если удобнее, можно подтвердить по ссылке:', String(verifyUrl))
  }
  const text = textLines.join('\n')

  const html = `
    <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; line-height: 1.4;">
      <h2 style="margin: 0 0 12px;">Ваш код подтверждения</h2>
      <div style="font-size: 32px; font-weight: 800; letter-spacing: 6px; margin: 0 0 10px;">${safeCode}</div>
      <div style="color: #555; margin: 0 0 14px;">Код действует ${ttlMinutes} минут.</div>
      ${
        safeVerifyUrl
          ? `<div style="margin-top: 10px; color: #777; font-size: 13px;">
               Если удобнее, можно подтвердить по ссылке:
               <div><a href="${safeVerifyUrl}">${safeVerifyUrl}</a></div>
             </div>`
          : ''
      }
    </div>
  `

  // Prefer Resend if configured, else SMTP, else console.
  const viaResend = await trySendViaResend({ to: email, subject, text, html })
  if (viaResend.delivered) return viaResend

  const viaSmtp = await trySendViaSmtp({ to: email, subject, text, html })
  if (viaSmtp.delivered) return viaSmtp

  return { delivered: false, reason: 'not_configured', meta: { resend: viaResend, smtp: viaSmtp } }
}

