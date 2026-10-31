import type { LatencySample, ServerMessage, UsageEvent } from "../shared/protocol";
import { log } from "./log";
import type { LanguageStream, TranslationProvider, UsageDraft } from "./providers/types";

type LatencyDraft = Omit<LatencySample, "at">;

export type FanoutSinks = {
  toGuest: (guestId: string, message: ServerMessage) => void;
  toGuide: (message: ServerMessage) => void;
  onUsage: (usage: UsageDraft) => void;
  onLatency: (sample: LatencyDraft) => void;
};

export class LanguageFanout {
  private guests = new Map<string, string | null>();
  private streams = new Map<string, LanguageStream>();
  private failures = new Map<string, number>();
  private pending: Buffer[] = [];
  private chain: Promise<void> = Promise.resolve();
  private currentUtterance = "";
  private speechEndedAt = new Map<string, number>();
  private firstAudioAt = new Set<string>();
  private earlyEmitted = new Set<string>();
  private seq = new Map<string, number>();
  private speakingUntil = new Map<string, number>();
  private asking = new Set<string>();
  private activityKey = "";
  private activityTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly provider: TranslationProvider,
    private glossary: string[],
    private sinks: FanoutSinks,
  ) {}

  activeLanguages(): string[] {
    if (this.provider.delivery === "per-language-stream") return [...this.streams.keys()].sort();
    return [...new Set([...this.guests.values()].filter((lang): lang is string => Boolean(lang)))].sort();
  }

  addGuest(id: string, language: string | null): void {
    if (this.guests.has(id)) this.removeGuest(id);
    this.guests.set(id, language);
    if (language) this.ensure(language);
    this.emitPipelines();
  }

  removeGuest(id: string): void {
    const language = this.guests.get(id);
    this.guests.delete(id);
    if (language) this.release(language);
    this.emitPipelines();
  }

  setLanguage(id: string, language: string): void {
    if (!this.guests.has(id)) this.guests.set(id, null);
    const previous = this.guests.get(id);
    if (previous === language) return;
    this.guests.set(id, language);
    if (previous) this.release(previous);
    this.ensure(language);
    this.emitPipelines();
  }

  pushPcm(pcm: Buffer, utteranceId: string): void {
    this.currentUtterance = utteranceId;
    if (this.provider.delivery === "per-language-stream") {
      for (const language of new Set([...this.guests.values()].filter((lang): lang is string => Boolean(lang)))) {
        this.ensure(language);
      }
      for (const stream of this.streams.values()) stream.writePcm(pcm);
      return;
    }
    this.pending.push(pcm);
  }

  endUtterance(info: { utteranceId: string; hint?: string; speechEndedAt: number }): Promise<void> {
    this.currentUtterance = info.utteranceId;
    this.speechEndedAt.set(info.utteranceId, info.speechEndedAt);
    if (this.provider.delivery === "per-language-stream") {
      for (const stream of this.streams.values()) stream.endUtterance(info);
      this.flushEarly(info.utteranceId);
      return Promise.resolve();
    }
    const pcm = this.pending.length ? Buffer.concat(this.pending) : Buffer.alloc(0);
    this.pending = [];
    const targets = this.snapshotTargets();
    const run = this.chain.then(() => this.runShared(info, pcm, targets));
    this.chain = run.catch((error) => {
      this.sinks.toGuide({ type: "error", message: error instanceof Error ? error.message : String(error) });
    });
    return run;
  }

  async handleQuestion(guestId: string, language: string, pcm: Buffer, hint?: string): Promise<void> {
    const started = Date.now();
    this.asking.add(guestId);
    this.emitActivity();
    try {
      let original = hint?.trim() || "";
      if (!original) {
        const heard = await this.provider.transcribe(pcm, { glossary: this.glossary, language, hint });
        if (heard.usage) this.sinks.onUsage(heard.usage);
        original = heard.text.trim();
      }
      if (!original) original = "(question audio received)";
      const english = await this.provider.translateToEnglish(original, language, this.glossary);
      if (english.usage) this.sinks.onUsage(english.usage);
      const audio = await this.provider.synthesize(english.text, "en");
      if (audio.usage) this.sinks.onUsage(audio.usage);
      this.sinks.toGuide({
        type: "question",
        guestId,
        language,
        original,
        english: english.text,
        mime: "audio/wav",
        audio: audio.bytes.toString("base64"),
      });
      log("question", { language, ms: Date.now() - started, chars: english.text.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("question-error", { language, message: message.slice(0, 300) });
      // Before, only the guest saw this, so the guide never knew a question was lost.
      this.sinks.toGuide({ type: "error", message: `A ${language} guest question could not be translated: ${message}` });
      this.sinks.toGuest(guestId, { type: "error", message: "Your question could not be sent. Please try again." });
    } finally {
      this.asking.delete(guestId);
      this.emitActivity();
    }
  }

  close(): void {
    if (this.activityTimer) clearTimeout(this.activityTimer);
    for (const stream of this.streams.values()) stream.close();
    this.streams.clear();
  }

  private snapshotTargets(): Map<string, string[]> {
    const targets = new Map<string, string[]>();
    for (const [id, language] of this.guests) {
      if (!language) continue;
      const list = targets.get(language) ?? [];
      list.push(id);
      targets.set(language, list);
    }
    return targets;
  }

  private async runShared(
    info: { utteranceId: string; hint?: string; speechEndedAt: number },
    pcm: Buffer,
    targets: Map<string, string[]>,
  ): Promise<void> {
    const hint = info.hint?.trim();
    let text = hint || "";
    if (!text) {
      const heard = await this.provider.transcribe(pcm, { glossary: this.glossary, language: "en", hint });
      if (heard.usage) this.sinks.onUsage(heard.usage);
      text = heard.text.trim();
    }
    if (!text) text = "(no speech recognised)";
    this.sinks.toGuide({
      type: "caption",
      utteranceId: info.utteranceId,
      track: "source",
      language: "en",
      text,
      final: true,
    });
    await Promise.all(
      [...targets.entries()].map(async ([language, guestIds]) => {
        try {
          const translated = await this.provider.translate(text, language, this.glossary);
          if (translated.usage) this.sinks.onUsage({ ...translated.usage, language });
          this.sendCaption(language, guestIds, {
            type: "caption",
            utteranceId: info.utteranceId,
            track: "translation",
            language,
            text: translated.text,
            final: true,
          });
          const audio = await this.provider.synthesize(translated.text, language);
          if (audio.usage) this.sinks.onUsage({ ...audio.usage, language });
          this.sendAudio(language, guestIds, info.utteranceId, audio.bytes, audio.mime, audio.sampleRate, true);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          for (const id of guestIds) this.sinks.toGuest(id, { type: "error", message });
          this.sinks.toGuide({ type: "error", message: `${language}: ${message}` });
        }
      }),
    );
  }

  private ensure(language: string): void {
    if (this.provider.delivery !== "per-language-stream") return;
    if (this.streams.has(language)) return;
    if ((this.failures.get(language) ?? 0) >= 3) return;
    const support = this.provider.supports(language);
    if (!support.live) {
      this.sinks.toGuide({ type: "error", message: `${language} is not available on ${this.provider.label}` });
      return;
    }
    if (!this.provider.openLanguageStream) return;
    const stream = this.provider.openLanguageStream(language, {
      onAudio: (chunk) => {
        this.failures.set(language, 0);
        this.noteSpeaking(language, chunk.bytes.length / 2 / (chunk.sampleRate || 24000));
        const ids = [...this.guests.entries()].filter(([, lang]) => lang === language).map(([id]) => id);
        this.sendAudio(language, ids, this.currentUtterance || "live", chunk.bytes, chunk.mime, chunk.sampleRate, Boolean(chunk.end));
      },
      onCaption: (caption) => {
        if (caption.track === "source") {
          const primary = [...this.streams.keys()].sort()[0];
          if (primary && language !== primary) return;
          this.sinks.toGuide({
            type: "caption",
            utteranceId: this.currentUtterance || "live",
            track: "source",
            language: "en",
            text: caption.text,
            final: caption.final,
          });
          return;
        }
        const ids = [...this.guests.entries()].filter(([, lang]) => lang === language).map(([id]) => id);
        this.sendCaption(language, ids, {
          type: "caption",
          utteranceId: this.currentUtterance || "live",
          track: "translation",
          language,
          text: caption.text,
          final: caption.final,
        });
      },
      onUsage: (usage) => this.sinks.onUsage(usage),
      onError: (error) => {
        const count = (this.failures.get(language) ?? 0) + 1;
        log("translation-error", { language, count, message: error.message.slice(0, 300) });
        this.failures.set(language, count);
        this.streams.get(language)?.close();
        this.streams.delete(language);
        this.sinks.toGuide({
          type: "error",
          message: count >= 3 ? `${language} stopped after repeated errors: ${error.message}` : `${language}: ${error.message}`,
        });
        this.emitPipelines();
      },
    }, { glossary: this.glossary });
    this.streams.set(language, stream);
    log("translation-open", { language, provider: this.provider.id });
  }

  private noteSpeaking(language: string, seconds: number): void {
    const now = Date.now();
    const until = Math.max(this.speakingUntil.get(language) ?? 0, now) + seconds * 1000;
    this.speakingUntil.set(language, until);
    this.emitActivity();
  }

  /** Tell the guide which languages are speaking. Sent only when the set changes. */
  private emitActivity(): void {
    const now = Date.now();
    const speaking = [...this.speakingUntil.entries()].filter(([, until]) => until > now - 300).map(([lang]) => lang).sort();
    const asking = [...this.asking].sort();
    const key = `${speaking.join(",")}|${asking.join(",")}`;
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.activityTimer = null;
    if (speaking.length) {
      const next = Math.min(...speaking.map((lang) => this.speakingUntil.get(lang) ?? now)) - now + 350;
      this.activityTimer = setTimeout(() => this.emitActivity(), Math.max(200, next));
      this.activityTimer.unref?.();
    }
    if (key === this.activityKey) return;
    this.activityKey = key;
    this.sinks.toGuide({ type: "activity", speaking, asking });
  }

  private release(language: string): void {
    if (this.listeners(language) > 0) return;
    this.streams.get(language)?.close();
    this.streams.delete(language);
    this.speakingUntil.delete(language);
    log("translation-close", { language });
  }

  private listeners(language: string): number {
    let count = 0;
    for (const value of this.guests.values()) if (value === language) count += 1;
    return count;
  }

  private sendCaption(language: string, guestIds: string[], message: Extract<ServerMessage, { type: "caption" }>): void {
    for (const id of guestIds) {
      if (this.guests.get(id) === language) this.sinks.toGuest(id, message);
    }
  }

  private sendAudio(
    language: string,
    guestIds: string[],
    utteranceId: string,
    bytes: Buffer,
    mime: "audio/wav" | "audio/pcm",
    sampleRate: number,
    end: boolean,
  ): void {
    this.noteFirstAudio(utteranceId, language);
    const key = `${utteranceId}|${language}`;
    const seq = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, seq);
    const message: ServerMessage = {
      type: "audio",
      utteranceId,
      language,
      mime,
      sampleRate,
      data: bytes.toString("base64"),
      seq,
      end,
      speechEndedAt: this.speechEndedAt.get(utteranceId) ?? 0,
    };
    for (const id of guestIds) {
      if (this.guests.get(id) === language) this.sinks.toGuest(id, message);
    }
  }

  private noteFirstAudio(utteranceId: string, language: string): void {
    const key = `${utteranceId}|${language}`;
    if (this.firstAudioAt.has(key)) return;
    this.firstAudioAt.add(key);
    const ended = this.speechEndedAt.get(utteranceId);
    if (!ended) return;
    this.sinks.onLatency({
      utteranceId,
      language,
      pipelineMs: Math.max(0, Date.now() - ended),
      early: false,
    });
  }

  private flushEarly(utteranceId: string): void {
    for (const language of this.activeLanguages()) {
      const key = `${utteranceId}|${language}`;
      if (!this.firstAudioAt.has(key) || this.earlyEmitted.has(key)) continue;
      this.earlyEmitted.add(key);
      this.sinks.onLatency({ utteranceId, language, pipelineMs: 0, early: true });
    }
  }

  private emitPipelines(): void {
    this.sinks.toGuide({ type: "pipelines", languages: this.activeLanguages() });
  }
}

export type { UsageEvent };
