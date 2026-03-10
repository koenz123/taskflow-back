/**
 * Telephone bot API: Telphin Call Interactive webhook + test-dialog endpoint.
 * Controller layer: parse request, call dialog service, return XML or JSON.
 */

import express from 'express'
import { createLlmClient } from '../services/telephone/llm/createLlmClient.js'
import { createDialogService } from '../services/telephone/dialogService.js'
import {
  buildCallInteractiveResponse,
  ttsAction,
  jumpAction,
  hangupAction,
} from '../services/telephone/telphinXml.js'

const SYSTEM_PROMPT =
  (process.env.SYSTEM_PROMPT ?? '').trim() ||
  'Ты голосовой ассистент. Отвечай кратко и содержательно по теме, одним-двумя предложениями, чтобы ответ можно было озвучить по телефону.'
const IVR_JUMP_CONTEXT = (process.env.IVR_JUMP_CONTEXT ?? '').trim()
const IVR_JUMP_OPTION = (process.env.IVR_JUMP_OPTION ?? '').trim()

let dialogServicePromise = null

async function getDialogService() {
  if (dialogServicePromise === null) {
    dialogServicePromise = createLlmClient().then((llm) => {
      if (!llm) return null
      return createDialogService(llm, SYSTEM_PROMPT)
    })
  }
  return dialogServicePromise
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}

/**
 * @returns {express.Router}
 */
export function createTelephoneApi() {
  const router = express.Router()

  router.use(express.urlencoded({ extended: false }))
  router.use(express.json())

  const handleCallInteractive = async (req, res) => {
    const q = req.method === 'POST' && req.body && typeof req.body === 'object'
      ? { ...req.query, ...req.body }
      : { ...req.query }
    const callApiId = q.CallAPIID ?? q.CallID ?? 'unknown'
    const stt = (q.voice_navigator_STT != null ? String(q.voice_navigator_STT) : '').trim()
    const dtmf = (q.voice_navigator_DTMF != null ? String(q.voice_navigator_DTMF) : '').trim()
    const userText = stt || dtmf || null

    const logger = req.app?.locals?.logger
    if (logger) logger.info({ callApiId, hasUserText: !!userText }, 'Call Interactive request')

    const dialogService = await getDialogService()
    if (!dialogService) {
      const xml = buildCallInteractiveResponse([
        ttsAction('Настройте GIGACHAT_CREDENTIALS или OPENAI_API_KEY в переменных окружения.'),
      ])
      res.setHeader('Content-Type', 'application/xml; charset=utf-8')
      return res.send(xml)
    }

    try {
      const result = await dialogService.handleTurn(callApiId, userText)
      const actions = [ttsAction(result.textToSpeak)]
      if (result.shouldHangup) {
        actions.push(hangupAction())
      } else if (IVR_JUMP_CONTEXT && IVR_JUMP_OPTION) {
        actions.push(jumpAction(IVR_JUMP_CONTEXT, IVR_JUMP_OPTION))
      }
      const xml = buildCallInteractiveResponse(actions)
      res.setHeader('Content-Type', 'application/xml; charset=utf-8')
      return res.send(xml)
    } catch (err) {
      if (logger) logger.error({ err, callApiId }, 'Call Interactive error')
      const fallback = 'Произошла ошибка. Попробуйте позже.'
      const actions = [ttsAction(fallback)]
      if (IVR_JUMP_CONTEXT && IVR_JUMP_OPTION) {
        actions.push(jumpAction(IVR_JUMP_CONTEXT, IVR_JUMP_OPTION))
      }
      res.setHeader('Content-Type', 'application/xml; charset=utf-8')
      return res.send(buildCallInteractiveResponse(actions))
    }
  }

  router.get('/telphin/call-interactive', asyncHandler(handleCallInteractive))
  router.post('/telphin/call-interactive', asyncHandler(handleCallInteractive))
  router.get('/api/telphin/call-interactive', asyncHandler(handleCallInteractive))
  router.post('/api/telphin/call-interactive', asyncHandler(handleCallInteractive))

  router.post('/api/telephone/test-dialog', asyncHandler(async (req, res) => {
    const start = Date.now()
    const elapsed = () => Date.now() - start

    const dialogService = await getDialogService()
    if (!dialogService) {
      return res.status(400).json({
        error: 'Задайте GIGACHAT_CREDENTIALS или OPENAI_API_KEY в .env',
        elapsedMs: elapsed(),
      })
    }

    const userText =
      typeof req.body === 'object' && req.body && 'userText' in req.body
        ? String(req.body.userText ?? '').trim()
        : ''

    try {
      const result = await dialogService.handleTurn('test-session', userText || null)
      return res.json({ reply: result.textToSpeak, elapsedMs: elapsed() })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const logger = req.app?.locals?.logger
      if (logger) logger.error({ err, message }, 'Test dialog error')
      return res.status(500).json({
        error: message.slice(0, 600),
        elapsedMs: elapsed(),
      })
    }
  }))

  return router
}

/**
 * Pre-warm dialog service (LLM client) at server start so first call responds fast.
 * Call once after mounting the router, e.g. in index.js.
 */
export function warmupTelephoneBot() {
  getDialogService()
    .then((svc) => {
      if (svc) console.log('[telephone] LLM warm, ready for calls')
      else console.log('[telephone] No LLM keys set, Call Interactive will return setup message')
    })
    .catch((err) => console.warn('[telephone] Warmup failed:', err.message))
}
