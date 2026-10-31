import WebSocket from "ws";
import { protectNames, restoreNames } from "../../shared/glossary";
import { isLangCode, language } from "../../shared/languages";
import type { Config } from "../config";
import { geminiLiveUsd, geminiTextUsd } from "../rates";
import { pcmDurationSeconds, pcmToWav } from "../wav";
import { synthesizeSpeech } from "../speak";
import type { AudioResult, LanguageStream, ProviderContext, StreamHandlers, Support, TextResult, TranslationProvider } from "./types";

const LIVE_NOTE =
  "Gemini 3.5 Live Translate (speech to speech). Verified against the Live Translate guide, 31 Oct 2026. Not executed in this build without GEMINI_API_KEY.";
const SCRIPT_NOTE =
  "Script text is translated with gemini-2.5-flash. Live Translate does not accept text, so the stop's spoken audio is local espeak-ng.";

export function buildGeminiSetup(opts: { model: string; targetLanguageCode: string; glossary: string[] }) {
  return {
    setup: {
      model: `models/${opts.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: {
          targetLanguageCode: opts.targetLanguageCode,
          echoTargetLanguage: false,
        },
      },
      // The raw WebSocket API rejects these inside generationConfig (close 1007), despite the guide's sample.
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: {
        parts: [
          {
            text: `You are interpreting a live walking tour. Do not translate these proper names; keep and pronounce them exactly: ${opts.glossary.join(", ")}. Translate into the formal standard variety of the target language (for Arabic, Modern Standard Arabic / Fusha, not a dialect).`,
          },
        ],
      },
    },
  };
}

export function buildGeminiAudioMessage(pcmBase64: string) {
  return {
    realtimeInput: {
      audio: {
        data: pcmBase64,
        mimeType: "audio/pcm;rate=16000",
      },
    },
  };
}

export function buildGeminiAudioStreamEnd() {
  return { realtimeInput: { audioStreamEnd: true } };
}

export function buildGeminiTextBody(prompt: string) {
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2 },
  };
}

export function geminiGenerateUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

export class GeminiProvider implements TranslationProvider {
  id = "gemini";
  label = "Gemini Live Translate";
  delivery = "per-language-stream" as const;

  constructor(private config: Config) {}

  supports(code: string): Support {
    if (!isLangCode(code)) return { live: false, scripts: false, note: "Not a pilot language." };
    return { live: true, scripts: true, note: `${LIVE_NOTE} ${SCRIPT_NOTE}` };
  }

  openLanguageStream(lang: string, handlers: StreamHandlers, ctx: ProviderContext): LanguageStream {
    const info = language(lang);
    if (!info) throw new Error(`Unsupported language ${lang}`);
    if (!this.config.geminiKey) throw new Error("GEMINI_API_KEY is not set");
    return new GeminiLanguageStream(this.config, info.gemini, lang, ctx.glossary, handlers);
  }

  async transcribe(pcm: Buffer, opts: { glossary: string[]; language: string }): Promise<TextResult> {
    const wav = pcmToWav(pcm, 16000);
    const prompt = `Transcribe this speech in its own language. Output only the transcript. Spell these names exactly when you hear them: ${opts.glossary.join(", ")}.`;
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } },
            { text: prompt },
          ],
        },
      ],
      generationConfig: { temperature: 0 },
    };
    const data = await this.post(this.config.geminiTextModel, body);
    const text = geminiText(data);
    const seconds = pcmDurationSeconds(pcm);
    return {
      text,
      usage: {
        provider: "gemini",
        kind: "stt",
        language: opts.language,
        audioInputSeconds: seconds,
        audioOutputSeconds: 0,
        charactersIn: 0,
        charactersOut: text.length,
        estimatedUsd: geminiTextUsd(prompt.length, text.length),
        note: "Question audio via gemini-2.5-flash generateContent. Text-token estimate only.",
      },
    };
  }

  async translate(english: string, lang: string, glossary: string[]): Promise<TextResult> {
    const info = language(lang);
    if (!info) throw new Error(`Unsupported language ${lang}`);
    return this.translateText(english, info.name, glossary, lang);
  }

  async translateToEnglish(text: string, fromLanguage: string, glossary: string[]): Promise<TextResult> {
    if (fromLanguage === "en") {
      return { text, usage: emptyUsage("mt", "Already English.") };
    }
    const from = language(fromLanguage)?.name || fromLanguage;
    return this.translateText(text, `English. The source language is ${from}`, glossary, "en");
  }

  async synthesize(text: string, lang: string): Promise<AudioResult> {
    const spoken = await synthesizeSpeech(text, lang);
    return {
      bytes: spoken.bytes,
      mime: "audio/wav",
      sampleRate: spoken.sampleRate,
      usage: {
        provider: spoken.engine,
        kind: "tts",
        language: lang,
        audioInputSeconds: 0,
        audioOutputSeconds: spoken.seconds,
        charactersIn: text.length,
        charactersOut: text.length,
        estimatedUsd: 0,
        note: "Live Translate has no text input, so scripted stops use a local voice.",
      },
    };
  }

  private async translateText(source: string, targetName: string, glossary: string[], lang: string): Promise<TextResult> {
    const masked = protectNames(source, glossary);
    const prompt = [
      `Translate the tour speech into ${targetName}.`,
      "Output only the translation.",
      `Copy these tokens unchanged if they appear: ${masked.pairs.map((p) => p.token).join(" ") || "(none)"}.`,
      `Do not translate these proper names: ${glossary.join(", ")}.`,
      "",
      masked.text,
    ].join("\n");
    const data = await this.post(this.config.geminiTextModel, buildGeminiTextBody(prompt));
    const text = restoreNames(geminiText(data), masked.pairs);
    return {
      text,
      usage: {
        provider: "gemini",
        kind: "mt",
        language: lang,
        audioInputSeconds: 0,
        audioOutputSeconds: 0,
        charactersIn: source.length,
        charactersOut: text.length,
        estimatedUsd: geminiTextUsd(prompt.length, text.length),
        note: "gemini-2.5-flash text tokens estimated at 4 characters per token.",
      },
    };
  }

  private async post(model: string, body: unknown): Promise<unknown> {
    if (!this.config.geminiKey) throw new Error("GEMINI_API_KEY is not set");
    const response = await fetch(geminiGenerateUrl(model), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.config.geminiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Gemini ${model} HTTP ${response.status}: ${raw.slice(0, 400)}`);
    return JSON.parse(raw) as unknown;
  }
}

class GeminiLanguageStream implements LanguageStream {
  private socket: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private queue: Buffer[] = [];
  private inputBytes = 0;
  private caption = { source: "", translation: "" };
  private speaking = false;

  constructor(
    config: Config,
    private target: string,
    private lang: string,
    glossary: string[],
    private handlers: StreamHandlers,
  ) {
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(config.geminiKey)}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.on("open", () => {
      socket.send(JSON.stringify(buildGeminiSetup({ model: config.geminiLiveModel, targetLanguageCode: target, glossary })));
    });
    socket.on("message", (raw) => this.onMessage(raw.toString()));
    socket.on("error", (error) => {
      if (!this.closed) this.handlers.onError(error);
    });
    socket.on("close", (code, reason) => {
      if (!this.closed) this.handlers.onError(new Error(`Gemini ${this.lang} socket closed (${code}${reason.length ? `: ${reason.toString().slice(0, 200)}` : ""})`));
    });
  }

  writePcm(pcm: Buffer): void {
    if (this.closed) return;
    this.inputBytes += pcm.length;
    this.sendAudio(pcm);
  }

  private sendAudio(pcm: Buffer): void {
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.queue.push(pcm);
      return;
    }
    this.socket.send(JSON.stringify(buildGeminiAudioMessage(pcm.toString("base64"))));
  }

  endUtterance(): void {
    if (this.closed || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const seconds = this.inputBytes / 2 / 16000;
    this.inputBytes = 0;
    if (seconds > 0) {
      this.handlers.onUsage({
        provider: "gemini",
        kind: "live",
        language: this.lang,
        audioInputSeconds: seconds,
        audioOutputSeconds: 0,
        charactersIn: 0,
        charactersOut: 0,
        estimatedUsd: geminiLiveUsd(seconds, 0),
        note: "Published per-second rate. Live sessions can also re-bill context, which this estimate leaves out.",
      });
    }
    this.socket.send(JSON.stringify(buildGeminiAudioStreamEnd()));
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }

  private onMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.setupComplete) {
      this.ready = true;
      const queued = this.queue;
      this.queue = [];
      for (const chunk of queued) this.sendAudio(chunk);
      return;
    }
    const serverContent = message.serverContent as Record<string, unknown> | undefined;
    if (!serverContent) return;
    const input = serverContent.inputTranscription as { text?: string } | undefined;
    const output = serverContent.outputTranscription as { text?: string } | undefined;
    if (input?.text) {
      this.caption.source = mergeCaption(this.caption.source, input.text);
      this.handlers.onCaption({ track: "source", text: this.caption.source, final: false });
    }
    if (output?.text) {
      this.caption.translation = mergeCaption(this.caption.translation, output.text);
      this.handlers.onCaption({ track: "translation", text: this.caption.translation, final: false });
    }
    const turn = serverContent.modelTurn as { parts?: Array<Record<string, unknown>> } | undefined;
    for (const part of turn?.parts ?? []) {
      const inline = (part.inlineData || part.inline_data) as { data?: string } | undefined;
      if (!inline?.data) continue;
      const bytes = Buffer.from(inline.data, "base64");
      // After the speech is translated, Live Translate keeps streaming all-zero PCM
      // (~48 KB/s per language). Do not forward or bill it; use it to close the caption.
      if (isSilent(bytes)) {
        if (this.speaking) this.finishCaptions();
        this.speaking = false;
        continue;
      }
      this.speaking = true;
      const seconds = bytes.length / 2 / 24000;
      this.handlers.onAudio({ bytes, mime: "audio/pcm", sampleRate: 24000 });
      this.handlers.onUsage({
        provider: "gemini",
        kind: "live",
        language: this.lang,
        audioInputSeconds: 0,
        audioOutputSeconds: seconds,
        charactersIn: 0,
        charactersOut: 0,
        estimatedUsd: geminiLiveUsd(0, seconds),
        note: "Output audio at 24 kHz, 25 tokens per second.",
      });
    }
    if (serverContent.generationComplete || serverContent.turnComplete) this.finishCaptions();
  }

  private finishCaptions(): void {
    if (this.caption.source) this.handlers.onCaption({ track: "source", text: this.caption.source, final: true });
    if (this.caption.translation) {
      this.handlers.onCaption({ track: "translation", text: this.caption.translation, final: true });
    }
    this.caption = { source: "", translation: "" };
  }
}

export function isSilent(pcm: Buffer): boolean {
  for (let i = 0; i + 1 < pcm.length; i += 2) if (pcm.readInt16LE(i) !== 0) return false;
  return true;
}

function mergeCaption(previous: string, next: string): string {
  if (!previous) return next.trim();
  const incoming = next.trim();
  if (!incoming) return previous;
  if (incoming.startsWith(previous) || previous.startsWith(incoming)) return incoming.length >= previous.length ? incoming : previous;
  if (previous.endsWith(incoming)) return previous;
  return `${previous} ${incoming}`.trim();
}

function geminiText(data: unknown): string {
  const parts = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((part) => part.text || "").join("").trim();
}

function emptyUsage(kind: "mt", note: string): TextResult["usage"] {
  return {
    provider: "gemini",
    kind,
    audioInputSeconds: 0,
    audioOutputSeconds: 0,
    charactersIn: 0,
    charactersOut: 0,
    estimatedUsd: 0,
    note,
  };
}
