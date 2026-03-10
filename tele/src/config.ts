import "dotenv/config";

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export const config = {
  port: Number(optionalEnv("PORT", "3000")),
  baseUrl: optionalEnv("BASE_URL", "http://localhost:3000"),
  /** CORS: через запятую origins или * для любого */
  corsOrigin: optionalEnv("CORS_ORIGIN", "*"),

  openai: {
    apiKey: optionalEnv("OPENAI_API_KEY", ""),
    model: optionalEnv("OPENAI_MODEL", "gpt-4o-mini"),
  },

  gigachat: {
    credentials: optionalEnv("GIGACHAT_CREDENTIALS", ""),
    model: optionalEnv("GIGACHAT_MODEL", "GigaChat-2"),
    scope: optionalEnv("GIGACHAT_SCOPE", "GIGACHAT_API_PERS"),
  },

  systemPrompt: optionalEnv(
    "SYSTEM_PROMPT",
    "Ты голосовой ассистент. Отвечай кратко и содержательно по теме, одним-двумя предложениями, чтобы ответ можно было озвучить по телефону."
  ),

  ivrJumpContext: optionalEnv("IVR_JUMP_CONTEXT", ""),
  ivrJumpOption: optionalEnv("IVR_JUMP_OPTION", ""),
} as const;
