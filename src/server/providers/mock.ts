import { protectNames, restoreNames } from "../../shared/glossary";
import { isLangCode, type LangCode } from "../../shared/languages";
import { pcmDurationSeconds } from "../wav";
import { synthesizeSpeech } from "../speak";
import { phraseFor, pseudoTranslate, questionToEnglish } from "./phrases";
import type { AudioResult, Support, TextResult, TranslationProvider } from "./types";

const NOTE =
  "No API key. Known tour lines use a built-in phrasebook. Other lines keep place names and translate a few common words. Speech is espeak-ng on this machine, or a tone if espeak-ng is missing.";

export class MockProvider implements TranslationProvider {
  id = "mock";
  label = "Mock (no key)";
  delivery = "shared-stt" as const;

  supports(code: string): Support {
    if (!isLangCode(code)) return { live: false, scripts: false, note: "Not a pilot language." };
    return { live: true, scripts: true, note: NOTE };
  }

  async transcribe(pcm: Buffer, opts: { hint?: string }): Promise<TextResult> {
    if (opts.hint?.trim()) {
      return { text: opts.hint.trim(), usage: this.zero("stt", "Transcript supplied by the guide page.") };
    }
    if (pcm.length < 320) {
      return { text: "", usage: this.zero("stt", "No speech in this utterance.") };
    }
    return {
      text: "Speech detected. The mock provider has no speech-to-text. Tap Demo line, or use a browser transcript.",
      usage: {
        provider: "mock",
        kind: "stt",
        audioInputSeconds: pcmDurationSeconds(pcm),
        audioOutputSeconds: 0,
        charactersIn: 0,
        charactersOut: 0,
        estimatedUsd: 0,
        note: "Mock does not call a speech-to-text API.",
      },
    };
  }

  async translate(english: string, language: string, glossary: string[]): Promise<TextResult> {
    if (!isLangCode(language)) throw new Error(`Unsupported language ${language}`);
    const known = phraseFor(english, language);
    const masked = known ? null : protectNames(english, glossary);
    const translated = known ?? restoreNames(pseudoTranslate(masked!.text, language as LangCode), masked!.pairs);
    return {
      text: translated,
      usage: {
        provider: "mock",
        kind: "mt",
        language,
        audioInputSeconds: 0,
        audioOutputSeconds: 0,
        charactersIn: english.length,
        charactersOut: translated.length,
        estimatedUsd: 0,
        note: known ? "Phrasebook." : "Place-name mask plus a small word list.",
      },
    };
  }

  async translateToEnglish(text: string, fromLanguage: string): Promise<TextResult> {
    if (fromLanguage === "en") return { text, usage: this.zero("mt", "Already English.") };
    const known = questionToEnglish(text);
    const english = known ?? `Guest said: ${text}`;
    return {
      text: english,
      usage: {
        provider: "mock",
        kind: "mt",
        language: "en",
        audioInputSeconds: 0,
        audioOutputSeconds: 0,
        charactersIn: text.length,
        charactersOut: english.length,
        estimatedUsd: 0,
        note: known ? "Question phrasebook." : "Mock has no general translator for this question.",
      },
    };
  }

  async synthesize(text: string, language: string): Promise<AudioResult> {
    const spoken = await synthesizeSpeech(text, language);
    return {
      bytes: spoken.bytes,
      mime: "audio/wav",
      sampleRate: spoken.sampleRate,
      usage: {
        provider: spoken.engine,
        kind: "tts",
        language,
        audioInputSeconds: 0,
        audioOutputSeconds: spoken.seconds,
        charactersIn: text.length,
        charactersOut: text.length,
        estimatedUsd: 0,
        note: spoken.engine === "espeak-ng" ? "Local espeak-ng voice. Not billed." : "Tone fallback. Not billed.",
      },
    };
  }

  private zero(kind: "stt" | "mt" | "tts", note: string): TextResult["usage"] {
    return {
      provider: "mock",
      kind,
      audioInputSeconds: 0,
      audioOutputSeconds: 0,
      charactersIn: 0,
      charactersOut: 0,
      estimatedUsd: 0,
      note,
    };
  }
}
