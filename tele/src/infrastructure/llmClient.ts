/** Общий тип сообщений для любого LLM (OpenAI, GigaChat). */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Клиент LLM: один метод chat, возвращает текст ответа. */
export interface LLMClient {
  chat(messages: ChatMessage[]): Promise<string>;
}
