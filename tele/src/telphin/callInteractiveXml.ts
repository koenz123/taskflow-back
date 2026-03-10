/**
 * Build XML response for Telphin Call Interactive.
 * @see https://ringme-confluence.atlassian.net/wiki/spaces/Ringme/pages/1901920992
 */

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function ttsAction(text: string, options?: { lang?: string; playNow?: boolean }): string {
  const lang = options?.lang ?? "ru-RU";
  const playNow = options?.playNow !== false;
  const safe = escapeXml(text.trim());
  return `<TTS lang="${escapeXml(lang)}" play_now="${playNow ? "true" : "false"}">${safe}</TTS>`;
}

export function jumpAction(contextId: string, optionId: string): string {
  return `<Jump context="${escapeXml(contextId)}" option="${escapeXml(optionId)}"/>`;
}

export function hangupAction(): string {
  return "<Hangup/>";
}

export function pauseAction(seconds: number): string {
  return `<Pause length="${seconds}"/>`;
}

export function buildCallInteractiveResponse(actions: string[]): string {
  const body = actions.join("\n     ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
     ${body}
</Response>`;
}
