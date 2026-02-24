export function inferLocale(req) {
  const fromHeader =
    (typeof req?.headers?.['x-locale'] === 'string' && req.headers['x-locale'].trim()) ||
    (typeof req?.headers?.['x-lang'] === 'string' && req.headers['x-lang'].trim()) ||
    null
  const fromQuery = typeof req?.query?.locale === 'string' && req.query.locale.trim() ? req.query.locale.trim() : null
  const raw = (fromQuery || fromHeader || '').toLowerCase()
  if (raw.startsWith('ru')) return 'ru'
  if (raw.startsWith('en')) return 'en'

  const al = typeof req?.headers?.['accept-language'] === 'string' ? req.headers['accept-language'] : ''
  if (/\bru\b/i.test(al)) return 'ru'
  return 'en'
}

