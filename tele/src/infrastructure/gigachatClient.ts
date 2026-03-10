/**
 * GigaChat API client: OAuth token + chat completion.
 * Docs: https://developers.sber.ru/docs/ru/gigachat/api/reference/rest
 */

import type { ChatMessage, LLMClient } from "./llmClient.js";

const AUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const CHAT_URL = "https://gigachat.devices.sberbank.ru/api/v1/chat/completions";

export type { ChatMessage };

export interface GigaChatOptions {
  credentials: string;
  model: string;
  scope?: string;
}

interface TokenResponse {
  access_token: string;
  expires_at: number;
}

export class GigaChatClient implements LLMClient {
  private readonly credentials: string;
  private readonly model: string;
  private readonly scope: string;
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(options: GigaChatOptions) {
    this.credentials = options.credentials;
    this.model = options.model;
    this.scope = options.scope ?? "GIGACHAT_API_PERS";
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && this.expiresAt > now + 60_000) {
      return this.accessToken;
    }

    const response = await fetch(AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${this.credentials}`,
        RqUID: crypto.randomUUID(),
      },
      body: `scope=${encodeURIComponent(this.scope)}`,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GigaChat auth failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as TokenResponse;
    this.accessToken = data.access_token;
    this.expiresAt = data.expires_at ? data.expires_at * 1000 : now + 30 * 60 * 1000;
    return data.access_token;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const token = await this.getAccessToken();

    const response = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.7,
        max_tokens: 150,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GigaChat chat failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    return content ?? "";
  }
}
