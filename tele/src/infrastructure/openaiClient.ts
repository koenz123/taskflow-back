/**
 * OpenAI (ChatGPT) API client for chat completions.
 * @see https://platform.openai.com/docs/api-reference/chat
 */

import type { ChatMessage, LLMClient } from "./llmClient.js";

const CHAT_URL = "https://api.openai.com/v1/chat/completions";

export interface OpenAIClientOptions {
  apiKey: string;
  model?: string;
}

export class OpenAIClient implements LLMClient {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(options: OpenAIClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "gpt-4o-mini";
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const response = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
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
      throw new Error(`OpenAI chat failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    return content ?? "";
  }
}
