import type { UsageEvent } from "../../shared/protocol";

export type UsageDraft = Omit<UsageEvent, "at">;

export type Support = {
  live: boolean;
  scripts: boolean;
  note?: string;
};

export type TextResult = {
  text: string;
  usage?: UsageDraft;
};

export type AudioResult = {
  bytes: Buffer;
  mime: "audio/wav" | "audio/pcm";
  sampleRate: number;
  usage?: UsageDraft;
};

export type StreamHandlers = {
  onAudio: (chunk: { bytes: Buffer; mime: "audio/wav" | "audio/pcm"; sampleRate: number; end?: boolean }) => void;
  onCaption: (caption: { track: "source" | "translation"; text: string; final: boolean }) => void;
  onUsage: (usage: UsageDraft) => void;
  onError: (error: Error) => void;
};

export type ProviderContext = {
  glossary: string[];
};

export interface LanguageStream {
  writePcm(pcm: Buffer): void;
  endUtterance(info: { utteranceId: string; hint?: string; speechEndedAt: number }): void;
  close(): void;
}

export interface TranslationProvider {
  id: string;
  label: string;
  delivery: "per-language-stream" | "shared-stt";
  supports(code: string): Support;
  openLanguageStream?(language: string, handlers: StreamHandlers, ctx: ProviderContext): LanguageStream;
  transcribe(pcm: Buffer, opts: { glossary: string[]; language: string; hint?: string }): Promise<TextResult>;
  translate(english: string, language: string, glossary: string[]): Promise<TextResult>;
  translateToEnglish(text: string, fromLanguage: string, glossary: string[]): Promise<TextResult>;
  synthesize(text: string, language: string): Promise<AudioResult>;
}
