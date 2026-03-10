import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { buildCallInteractiveResponse, ttsAction, jumpAction, hangupAction } from "../../telphin/callInteractiveXml.js";
import { config } from "../../config.js";
import { DialogService } from "../../services/dialogService.js";
import type { LLMClient } from "../../infrastructure/llmClient.js";
import { OpenAIClient } from "../../infrastructure/openaiClient.js";
import { GigaChatClient } from "../../infrastructure/gigachatClient.js";

interface CallInteractiveQuery {
  EventType?: string;
  CallID?: string;
  CallAPIID?: string;
  CallerIDNum?: string;
  CalledNumber?: string;
  voice_navigator_STT?: string;
  CallFlow?: string;
  [key: string]: string | undefined;
}

function createLLMClient(): LLMClient | null {
  if (config.openai.apiKey.length > 0) {
    return new OpenAIClient({
      apiKey: config.openai.apiKey,
      model: config.openai.model,
    });
  }
  if (config.gigachat.credentials.length > 0) {
    return new GigaChatClient({
      credentials: config.gigachat.credentials,
      model: config.gigachat.model,
      scope: config.gigachat.scope,
    });
  }
  return null;
}

export async function callInteractiveRoutes(app: FastifyInstance): Promise<void> {
  const llm = createLLMClient();
  const dialogService = llm ? new DialogService(llm, config.systemPrompt) : null;

  app.get<{ Querystring: CallInteractiveQuery }>(
    "/telphin/call-interactive",
    async (request: FastifyRequest<{ Querystring: CallInteractiveQuery }>, reply: FastifyReply) => {
      const q = request.query;
      const callApiId = q.CallAPIID ?? q.CallID ?? "unknown";
      const userText = q.voice_navigator_STT?.trim() ?? null;

      request.log.info({ callApiId, hasUserText: !!userText }, "Call Interactive request");

      if (!dialogService) {
        request.log.warn("Neither OPENAI_API_KEY nor GIGACHAT_CREDENTIALS set");
        const xml = buildCallInteractiveResponse([ttsAction("Настройте OPENAI_API_KEY или GIGACHAT_CREDENTIALS в переменных окружения.")]);
        return reply.header("Content-Type", "application/xml; charset=utf-8").send(xml);
      }

      try {
        const result = await dialogService.handleTurn(callApiId, userText);
        const actions: string[] = [ttsAction(result.textToSpeak)];

        if (result.shouldHangup) {
          actions.push(hangupAction());
        } else if (config.ivrJumpContext && config.ivrJumpOption) {
          actions.push(jumpAction(config.ivrJumpContext, config.ivrJumpOption));
        }

        const xml = buildCallInteractiveResponse(actions);
        reply.header("Content-Type", "application/xml; charset=utf-8").send(xml);
      } catch (err) {
        request.log.error({ err, callApiId }, "Call Interactive error");
        const fallback = "Произошла ошибка. Попробуйте позже.";
        const actions = [ttsAction(fallback)];
        if (config.ivrJumpContext && config.ivrJumpOption) actions.push(jumpAction(config.ivrJumpContext, config.ivrJumpOption));
        reply.header("Content-Type", "application/xml; charset=utf-8").send(buildCallInteractiveResponse(actions));
      }
    }
  );

  app.post<{ Body: CallInteractiveQuery; Querystring: CallInteractiveQuery }>(
    "/telphin/call-interactive",
    async (request: FastifyRequest<{ Body: CallInteractiveQuery; Querystring: CallInteractiveQuery }>, reply: FastifyReply) => {
      const q = { ...request.query, ...request.body } as CallInteractiveQuery;
      const callApiId = q.CallAPIID ?? q.CallID ?? "unknown";
      const userText = q.voice_navigator_STT?.trim() ?? null;

      request.log.info({ callApiId, hasUserText: !!userText }, "Call Interactive request (POST)");

      if (!dialogService) {
        request.log.warn("Neither OPENAI_API_KEY nor GIGACHAT_CREDENTIALS set");
        const xml = buildCallInteractiveResponse([ttsAction("Настройте OPENAI_API_KEY или GIGACHAT_CREDENTIALS в переменных окружения.")]);
        return reply.header("Content-Type", "application/xml; charset=utf-8").send(xml);
      }

      try {
        const result = await dialogService.handleTurn(callApiId, userText);
        const actions: string[] = [ttsAction(result.textToSpeak)];

        if (result.shouldHangup) {
          actions.push(hangupAction());
        } else if (config.ivrJumpContext && config.ivrJumpOption) {
          actions.push(jumpAction(config.ivrJumpContext, config.ivrJumpOption));
        }

        const xml = buildCallInteractiveResponse(actions);
        reply.header("Content-Type", "application/xml; charset=utf-8").send(xml);
      } catch (err) {
        request.log.error({ err, callApiId }, "Call Interactive error");
        const fallback = "Произошла ошибка. Попробуйте позже.";
        const xml = buildCallInteractiveResponse([
          ttsAction(fallback),
          ...(config.ivrJumpContext && config.ivrJumpOption ? [jumpAction(config.ivrJumpContext, config.ivrJumpOption)] : []),
        ]);
        reply.header("Content-Type", "application/xml; charset=utf-8").send(xml);
      }
    }
  );

  app.post<{ Body: { userText?: string } }>(
    "/api/test-dialog",
    async (request: FastifyRequest<{ Body: { userText?: string } }>, reply: FastifyReply) => {
      const start = Date.now();
      const elapsed = () => Date.now() - start;

      if (!dialogService) {
        return reply.status(400).send({ error: "Задайте OPENAI_API_KEY или GIGACHAT_CREDENTIALS в .env", elapsedMs: elapsed() });
      }

      const userText = typeof request.body === "object" && request.body && "userText" in request.body
        ? String(request.body.userText ?? "").trim()
        : "";
      const callApiId = "test-session";

      try {
        const result = await dialogService.handleTurn(callApiId, userText || null);
        return reply.send({ reply: result.textToSpeak, elapsedMs: elapsed() });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.error({ err, message }, "Test dialog error");
        return reply.status(500).send({
          error: message.slice(0, 600),
          elapsedMs: elapsed(),
        });
      }
    }
  );
}
