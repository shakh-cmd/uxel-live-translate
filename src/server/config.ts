import dotenv from "dotenv";
import { parseGlossary } from "../shared/glossary";

dotenv.config();

export type ProviderId = "mock" | "gemini" | "openai";

export type Config = {
  port: number;
  host: string;
  guidePin: string;
  provider: ProviderId;
  geminiKey: string;
  openaiKey: string;
  maxGuests: number;
  storeAudio: boolean;
  glossary: string[];
  publicBaseUrl: string;
  dev: boolean;
  openaiSttModel: string;
  openaiTranslateModel: string;
  openaiTtsModel: string;
  openaiTtsVoice: string;
  geminiLiveModel: string;
  geminiTextModel: string;
  geminiSilencePadMs: number;
  geminiSilencePadMaxMs: number;
  idleSessionMinutes: number;
};

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function num(value: string | undefined, fallback: number): number {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const providerRaw = (env.TRANSLATION_PROVIDER || "mock").toLowerCase();
  const provider: ProviderId =
    providerRaw === "gemini" || providerRaw === "openai" || providerRaw === "mock" ? providerRaw : "mock";
  const nodeEnv = env.NODE_ENV || "development";
  return {
    port: Number(env.PORT || 4317),
    host: env.HOST || "0.0.0.0",
    guidePin: env.GUIDE_PIN || "2468",
    provider,
    geminiKey: env.GEMINI_API_KEY || "",
    openaiKey: env.OPENAI_API_KEY || "",
    maxGuests: Math.max(1, Math.min(30, Number(env.MAX_GUESTS || 6))),
    storeAudio: bool(env.STORE_AUDIO, false),
    glossary: parseGlossary(env.GLOSSARY),
    publicBaseUrl: (env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
    dev: nodeEnv !== "production",
    openaiSttModel: env.OPENAI_STT_MODEL || "gpt-transcribe",
    openaiTranslateModel: env.OPENAI_TRANSLATE_MODEL || "gpt-4.1-mini",
    openaiTtsModel: env.OPENAI_TTS_MODEL || "tts-1",
    openaiTtsVoice: env.OPENAI_TTS_VOICE || "nova",
    geminiLiveModel: env.GEMINI_LIVE_MODEL || "gemini-3.5-live-translate-preview",
    // gemini-2.5-flash now returns 404 for new API keys, which broke questions and stops.
    geminiTextModel: env.GEMINI_TEXT_MODEL || "gemini-3.5-flash-lite",
    geminiSilencePadMs: num(env.GEMINI_SILENCE_PAD_MS, 4000),
    geminiSilencePadMaxMs: num(env.GEMINI_SILENCE_PAD_MAX_MS, 30000),
    idleSessionMinutes: num(env.IDLE_SESSION_MINUTES, 30),
  };
}
