import { LANGUAGES } from "../../shared/languages";
import type { LanguageOffer } from "../../shared/protocol";
import type { Config, ProviderId } from "../config";
import { GeminiProvider } from "./gemini";
import { MockProvider } from "./mock";
import { OpenAIProvider } from "./openai";
import type { TranslationProvider } from "./types";

export function createProvider(config: Config): TranslationProvider {
  if (config.provider === "mock") return new MockProvider();
  if (config.provider === "gemini") {
    if (!config.geminiKey) throw new Error("GEMINI_API_KEY is required when TRANSLATION_PROVIDER=gemini");
    return new GeminiProvider(config);
  }
  if (config.provider === "openai") {
    if (!config.openaiKey) throw new Error("OPENAI_API_KEY is required when TRANSLATION_PROVIDER=openai");
    return new OpenAIProvider(config);
  }
  throw new Error(`Unknown TRANSLATION_PROVIDER "${config.provider as ProviderId}"`);
}

export function languageOffers(provider: TranslationProvider): LanguageOffer[] {
  return LANGUAGES.map((lang) => {
    const support = provider.supports(lang.code);
    return {
      code: lang.code,
      name: lang.name,
      native: lang.native,
      dir: lang.dir,
      live: support.live,
      scripts: support.scripts,
      note: support.note,
    };
  });
}

export type { TranslationProvider } from "./types";
