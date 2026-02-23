import { Resend } from 'resend'

export function getResendClient() {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim()
  if (!apiKey) {
    // Explicit log to make "nothing happens" issues obvious in docker logs.
    console.warn('[resend] RESEND_API_KEY is missing')
    return null
  }
  return new Resend(apiKey)
}

