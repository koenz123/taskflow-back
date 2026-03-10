import type { ChatMessage } from "../infrastructure/llmClient.js";
import type { LLMClient } from "../infrastructure/llmClient.js";
import { getHistory, appendTurn } from "./sessionStore.js";

const TTS_MAX_CHARS = 500;

export interface DialogResult {
  textToSpeak: string;
  shouldHangup: boolean;
}

export class DialogService {
  constructor(
    private readonly llm: LLMClient,
    private readonly systemPrompt: string
  ) {}

  async handleTurn(callApiId: string, userText: string | null): Promise<DialogResult> {
    const history = getHistory(callApiId);

    if (!userText || userText.trim() === "") {
      const welcome =
        "Здравствуй! Айгуль, с днём рождения тебя! Пусть будет всё огонь, здоровье, счастье, мечты. " +
        "А теперь рэп про днюху сеструху: Йо! День рождения — это кайф, сеструха в центре, весь мир — твой штаб. " +
        "Торт, подарки, улыбки до ушей — круче только кексы и друзья веселей. С днюхой, красотка, качаем этот день!";
      appendTurn(callApiId, "assistant", welcome);
      return { textToSpeak: welcome, shouldHangup: false };
    }

    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...history.map((t) => ({ role: t.role, content: t.content } as ChatMessage)),
      { role: "user", content: userText.trim() },
    ];

    const response = await this.llm.chat(messages);
    const trimmed = response.slice(0, TTS_MAX_CHARS).trim();
    appendTurn(callApiId, "user", userText.trim());
    appendTurn(callApiId, "assistant", trimmed);

    const shouldHangup = /до свидания|пока|завершить|закончить|всё$/i.test(trimmed);

    return { textToSpeak: trimmed || "Не удалось сформировать ответ.", shouldHangup };
  }
}
