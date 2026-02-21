import { Resend } from 'resend'

export function getResendClient() {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim()
  if (!apiKey) return null
  return new Resend(apiKey)
}

