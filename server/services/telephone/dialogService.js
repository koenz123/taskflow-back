/**
 * Dialog service: welcome on empty input, LLM turn with history, TTS length limit, hangup detection.
 */

import { getHistory, appendTurn } from './sessionStore.js'

const TTS_MAX_CHARS = 500
const DEFAULT_WELCOME = 'Здравствуйте! Я голосовой помощник. Скажите, чем могу помочь?'
const HANGUP_PATTERN = /до свидания|пока|завершить|закончить|всё$/i

/**
 * @param {{ chat: (messages: { role: string; content: string }[]) => Promise<string> }} llm
 * @param {string} systemPrompt
 */
export function createDialogService(llm, systemPrompt) {
  /**
   * @param {string} callApiId
   * @param {string | null} userText
   * @returns {Promise<{ textToSpeak: string; shouldHangup: boolean }>}
   */
  async function handleTurn(callApiId, userText) {
    const history = getHistory(callApiId)

    if (!userText || String(userText).trim() === '') {
      const welcome = DEFAULT_WELCOME
      appendTurn(callApiId, 'assistant', welcome)
      return { textToSpeak: welcome, shouldHangup: false }
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map((t) => ({ role: t.role, content: t.content })),
      { role: 'user', content: String(userText).trim() },
    ]

    const response = await llm.chat(messages)
    const trimmed = response.slice(0, TTS_MAX_CHARS).trim()
    appendTurn(callApiId, 'user', String(userText).trim())
    appendTurn(callApiId, 'assistant', trimmed)

    const shouldHangup = HANGUP_PATTERN.test(trimmed)
    return {
      textToSpeak: trimmed || 'Не удалось сформировать ответ.',
      shouldHangup,
    }
  }

  return { handleTurn }
}
