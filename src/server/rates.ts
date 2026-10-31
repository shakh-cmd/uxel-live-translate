/**
 * Published prices checked 31 Oct 2026. These feed a session estimate, not an invoice.
 * Gemini Live may re-bill accumulated context each turn, so a real invoice can be higher
 * than the per-second audio rate used here.
 * Sources:
 * - https://ai.google.dev/gemini-api/docs/pricing
 * - https://developers.openai.com/api/docs/pricing
 */
export const RATES = {
  geminiLive: {
    model: "gemini-3.5-live-translate-preview",
    tokensPerSecond: 25,
    inputUsdPerMillion: 3.5,
    outputUsdPerMillion: 21,
  },
  geminiText: {
    model: "gemini-2.5-flash",
    inputUsdPerMillion: 0.3,
    outputUsdPerMillion: 2.5,
  },
  openai: {
    sttModel: "gpt-transcribe",
    sttUsdPerMinute: 0.0045,
    ttsModel: "tts-1",
    ttsUsdPerMillionChars: 15,
    ttsHdUsdPerMillionChars: 30,
    miniTtsTextUsdPerMillionTokens: 0.6,
    translateModel: "gpt-4.1-mini",
    translateInputUsdPerMillion: 0.4,
    translateOutputUsdPerMillion: 1.6,
  },
};

export function tokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}

export function geminiLiveUsd(inputSeconds: number, outputSeconds: number): number {
  const inTokens = inputSeconds * RATES.geminiLive.tokensPerSecond;
  const outTokens = outputSeconds * RATES.geminiLive.tokensPerSecond;
  return (
    (inTokens / 1_000_000) * RATES.geminiLive.inputUsdPerMillion +
    (outTokens / 1_000_000) * RATES.geminiLive.outputUsdPerMillion
  );
}

export function geminiTextUsd(inputChars: number, outputChars: number): number {
  return (
    (tokensFromChars(inputChars) / 1_000_000) * RATES.geminiText.inputUsdPerMillion +
    (tokensFromChars(outputChars) / 1_000_000) * RATES.geminiText.outputUsdPerMillion
  );
}

export function openaiSttUsd(seconds: number): number {
  return (seconds / 60) * RATES.openai.sttUsdPerMinute;
}

export function openaiTranslateUsd(inputChars: number, outputChars: number): number {
  return (
    (tokensFromChars(inputChars) / 1_000_000) * RATES.openai.translateInputUsdPerMillion +
    (tokensFromChars(outputChars) / 1_000_000) * RATES.openai.translateOutputUsdPerMillion
  );
}

export function openaiTtsUsd(model: string, characters: number): { usd: number; note?: string } {
  if (model === "tts-1-hd") {
    return { usd: (characters / 1_000_000) * RATES.openai.ttsHdUsdPerMillionChars };
  }
  if (model === "tts-1") {
    return { usd: (characters / 1_000_000) * RATES.openai.ttsUsdPerMillionChars };
  }
  const textUsd = (tokensFromChars(characters) / 1_000_000) * RATES.openai.miniTtsTextUsdPerMillionTokens;
  return {
    usd: textUsd,
    note: "gpt-4o-mini-tts also bills output audio at $12 / 1M audio tokens. That part is not in this estimate.",
  };
}
