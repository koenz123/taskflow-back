/**
 * Build XML response for Telphin Call Interactive.
 * @see https://ringme-confluence.atlassian.net/wiki/spaces/Ringme/pages/1901920992
 */

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * @param {string} text
 * @param {{ lang?: string; playNow?: boolean }} [options]
 * @returns {string}
 */
export function ttsAction(text, options = {}) {
  const lang = options.lang ?? 'ru-RU'
  const playNow = options.playNow !== false
  const safe = escapeXml(String(text).trim())
  return `<TTS lang="${escapeXml(lang)}" play_now="${playNow ? 'true' : 'false'}">${safe}</TTS>`
}

/**
 * @param {string} contextId
 * @param {string} optionId
 * @returns {string}
 */
export function jumpAction(contextId, optionId) {
  return `<Jump context="${escapeXml(contextId)}" option="${escapeXml(optionId)}"/>`
}

/**
 * @returns {string}
 */
export function hangupAction() {
  return '<Hangup/>'
}

/**
 * @param {number} seconds
 * @returns {string}
 */
export function pauseAction(seconds) {
  return `<Pause length="${Number(seconds)}"/>`
}

/**
 * @param {string[]} actions
 * @returns {string}
 */
export function buildCallInteractiveResponse(actions) {
  const body = actions.join('\n     ')
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
     ${body}
</Response>`
}
