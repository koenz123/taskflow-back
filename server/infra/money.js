export function currencyFromLocale(locale) {
  return locale === 'ru' ? 'RUB' : 'USD'
}

export function normalizeCurrency(v) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  const up = s.toUpperCase()
  if (up === 'RUB' || up === 'RUR' || up === 'РУБ' || s === '₽') return 'RUB'
  if (up === 'USD' || s === '$') return 'USD'
  return null
}

export function round2(n) {
  return Math.round(n * 100) / 100
}

// Base currency for backend storage: RUB.
export function toRub(amount, currency, usdRubRate) {
  const a = typeof amount === 'number' && Number.isFinite(amount) ? amount : NaN
  if (!Number.isFinite(a)) return NaN
  if (currency === 'USD') return round2(a * usdRubRate)
  return round2(a)
}

export function fromRub(amountRub, currency, usdRubRate) {
  const a = typeof amountRub === 'number' && Number.isFinite(amountRub) ? amountRub : NaN
  if (!Number.isFinite(a)) return NaN
  if (currency === 'USD') return round2(a / usdRubRate)
  return round2(a)
}

