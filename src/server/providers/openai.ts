import { protectNames, restoreNames } from "../../shared/glossary";
import { isLangCode, language } from "../../shared/languages";
import type { Config } from "../config";
import { openaiSttUsd, openaiTranslateUsd, openaiTtsUsd } from "../rates";
import { pcmDurationSeconds, pcmToWav, wavDurationSeconds } from "../wav";
import type { AudioResult, Support, TextResult, TranslationProvider } from "./types";

const NOTE =
  "Sentence-based stack on one OpenAI key: gpt-transcribe, then gpt-4.1-mini, then tts-1. Checked against the Audio and Chat Completions docs, 31 Oct 2026. Not the same as gpt-realtime-translate, which has no Arabic, Turkish, Polish, or Malay output. These speech models are scheduled to shut down on 6 Jan 2027; set OPENAI_TTS_MODEL if you move sooner.";

export function buildOpenAiTranslateBody(opts: { model: string; system: string; user: string }) {
  return {
    model: opts.model,
    temperature: 0.2,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  };
}

export function buildOpenAiSpeechBody(opts: { model: string; input: string; voice: string }) {
  return {
    model: opts.model,
    voice: opts.voice,
    input: opts.input,
    response_format: "wav" as const,
  };
}

export function openAiTranscriptionFields(opts: { model: string; language: string; prompt: string }) {
  return {
    model: opts.model,
    language: opts.language,
    prompt: opts.prompt,
    response_format: "json",
  };
}

export function translationSystem(targetName: string, glossary: string[]): string {
  return [
    `You interpret a live walking tour into ${targetName}.`,
    "Output only the spoken translation. No quotes, labels, or notes.",
    "Keep numbers, times, prices, and safety warnings accurate.",
    `Never translate these proper names. Copy them exactly, including any token that looks like ⟦N0⟧: ${glossary.join(", ")}.`,
  ].join(" ");
}

export class OpenAIProvider implements TranslationProvider {
  id = "openai";
  label = "OpenAI speech + translation + speech";
  delivery = "shared-stt" as const;

  constructor(private config: Config) {}

  supports(code: string): Support {
    if (!isLangCode(code)) return { live: false, scripts: false, note: "Not a pilot language." };
    return { live: true, scripts: true, note: NOTE };
  }

  async transcribe(pcm: Buffer, opts: { glossary: string[]; language: string; hint?: string }): Promise<TextResult> {
    if (opts.hint?.trim() && pcm.length < 320) {
      return { text: opts.hint.trim() };
    }
    const fields = openAiTranscriptionFields({
      model: this.config.openaiSttModel,
      language: opts.language,
      prompt: `Tour guide. Spell these names exactly: ${opts.glossary.join(", ")}.`,
    });
    const wav = pcmToWav(pcm, 16000);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)]), "speech.wav");
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    const data = await this.request("https://api.openai.com/v1/audio/transcriptions", form);
    const text = String((data as { text?: string }).text || opts.hint || "").trim();
    const seconds = pcmDurationSeconds(pcm);
    return {
      text,
      usage: {
        provider: "openai",
        kind: "stt",
        language: opts.language,
        audioInputSeconds: seconds,
        audioOutputSeconds: 0,
        charactersIn: 0,
        charactersOut: text.length,
        estimatedUsd: openaiSttUsd(seconds),
        note: `${this.config.openaiSttModel} at $0.0045 per minute.`,
      },
    };
  }

  async translate(english: string, lang: string, glossary: string[]): Promise<TextResult> {
    const info = language(lang);
    if (!info) throw new Error(`Unsupported language ${lang}`);
    return this.complete(english, translationSystem(info.name, glossary), lang, glossary);
  }

  async translateToEnglish(text: string, fromLanguage: string, glossary: string[]): Promise<TextResult> {
    if (fromLanguage === "en") return { text };
    const from = language(fromLanguage)?.name || fromLanguage;
    return this.complete(text, translationSystem(`English. The guest spoke ${from}`, glossary), "en", glossary);
  }

  async synthesize(text: string, lang: string): Promise<AudioResult> {
    const body = buildOpenAiSpeechBody({
      model: this.config.openaiTtsModel,
      input: text.slice(0, 4096),
      voice: this.config.openaiTtsVoice,
    });
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OpenAI speech HTTP ${response.status}: ${detail.slice(0, 400)}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const priced = openaiTtsUsd(this.config.openaiTtsModel, text.length);
    return {
      bytes,
      mime: "audio/wav",
      sampleRate: 24000,
      usage: {
        provider: "openai",
        kind: "tts",
        language: lang,
        audioInputSeconds: 0,
        audioOutputSeconds: wavDurationSeconds(bytes),
        charactersIn: text.length,
        charactersOut: text.length,
        estimatedUsd: priced.usd,
        note: priced.note || `${this.config.openaiTtsModel} character price.`,
      },
    };
  }

  private async complete(source: string, system: string, lang: string, glossary: string[]): Promise<TextResult> {
    const masked = protectNames(source, glossary);
    const body = buildOpenAiTranslateBody({
      model: this.config.openaiTranslateModel,
      system,
      user: masked.text,
    });
    const data = await this.request("https://api.openai.com/v1/chat/completions", body);
    const text = restoreNames(chatText(data), masked.pairs);
    return {
      text,
      usage: {
        provider: "openai",
        kind: "mt",
        language: lang,
        audioInputSeconds: 0,
        audioOutputSeconds: 0,
        charactersIn: source.length,
        charactersOut: text.length,
        estimatedUsd: openaiTranslateUsd(source.length + system.length, text.length),
        note: `${this.config.openaiTranslateModel} at $0.40 / $1.60 per 1M tokens, estimated at 4 characters per token.`,
      },
    };
  }

  private key(): string {
    if (!this.config.openaiKey) throw new Error("OPENAI_API_KEY is not set");
    return this.config.openaiKey;
  }

  private async request(url: string, body: FormData | Record<string, unknown>): Promise<unknown> {
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const response = await fetch(url, {
      method: "POST",
      headers: isForm
        ? { Authorization: `Bearer ${this.key()}` }
        : { Authorization: `Bearer ${this.key()}`, "Content-Type": "application/json" },
      body: isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${raw.slice(0, 400)}`);
    return JSON.parse(raw) as unknown;
  }
}

function chatText(data: unknown): string {
  const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : (part as { text?: string })?.text || ""))
      .join("")
      .trim();
  }
  return "";
}
