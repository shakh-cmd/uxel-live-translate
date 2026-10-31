export type LangCode =
  | "de"
  | "es"
  | "fr"
  | "it"
  | "ru"
  | "ar"
  | "tr"
  | "pl"
  | "ms"
  | "ja"
  | "zh"
  | "pt";

export type LanguageInfo = {
  code: LangCode;
  name: string;
  native: string;
  dir: "ltr" | "rtl";
  /** BCP-47 code for Gemini Live Translate. */
  gemini: string;
  /** espeak-ng voice name. All of these exist in espeak-ng 1.51. */
  espeak: string;
};

export const LANGUAGES: LanguageInfo[] = [
  { code: "de", name: "German", native: "Deutsch", dir: "ltr", gemini: "de", espeak: "de" },
  { code: "es", name: "Spanish", native: "Español", dir: "ltr", gemini: "es", espeak: "es" },
  { code: "fr", name: "French", native: "Français", dir: "ltr", gemini: "fr", espeak: "fr-fr" },
  { code: "it", name: "Italian", native: "Italiano", dir: "ltr", gemini: "it", espeak: "it" },
  { code: "ru", name: "Russian", native: "Русский", dir: "ltr", gemini: "ru", espeak: "ru" },
  { code: "ar", name: "Arabic", native: "العربية", dir: "rtl", gemini: "ar", espeak: "ar" },
  { code: "tr", name: "Turkish", native: "Türkçe", dir: "ltr", gemini: "tr", espeak: "tr" },
  { code: "pl", name: "Polish", native: "Polski", dir: "ltr", gemini: "pl", espeak: "pl" },
  { code: "ms", name: "Malay", native: "Bahasa Melayu", dir: "ltr", gemini: "ms", espeak: "ms" },
  { code: "ja", name: "Japanese", native: "日本語", dir: "ltr", gemini: "ja", espeak: "ja" },
  { code: "zh", name: "Chinese", native: "中文", dir: "ltr", gemini: "zh-Hans", espeak: "cmn" },
  { code: "pt", name: "Portuguese", native: "Português", dir: "ltr", gemini: "pt-BR", espeak: "pt-br" },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export function isLangCode(value: string): value is LangCode {
  return BY_CODE.has(value as LangCode);
}

export function language(code: string): LanguageInfo | undefined {
  return BY_CODE.get(code as LangCode);
}

export const ENGLISH = {
  code: "en" as const,
  name: "English",
  native: "English",
  espeak: "en-us",
};
