import type { LangCode } from "./languages";

export type SignalLevel = "good" | "weak" | "none";
export type LinkState = "connected" | "lagging" | "offline";

export const LAG_PIPELINE_MS = 3000;
export const LAG_RTT_MS = 800;
export const MAX_QUESTION_MS = 15_000;

export function connectionState(input: {
  online: boolean;
  rttMs?: number | null;
  lastPipelineMs?: number | null;
  early?: boolean;
}): LinkState {
  if (!input.online) return "offline";
  const slowPipe = input.lastPipelineMs != null && !input.early && input.lastPipelineMs > LAG_PIPELINE_MS;
  const slowNet = (input.rttMs ?? 0) > LAG_RTT_MS;
  if (slowPipe || slowNet) return "lagging";
  return "connected";
}

export type ClientMessage =
  | { type: "hello"; role: "guide"; clientId: string; pin: string }
  | { type: "hello"; role: "guest"; clientId: string; language?: string }
  | { type: "broadcast"; action: "start" | "stop" }
  | { type: "audio"; pcm: string; seq: number; utteranceId: string; end: boolean; hint?: string }
  | { type: "demo"; text: string }
  | { type: "language"; language: string }
  | { type: "question"; pcm?: string; hint?: string; utteranceId: string; language: string }
  | { type: "play-stop"; stopId: string }
  | { type: "heartbeat"; online: boolean; rttMs?: number; signal?: SignalLevel }
  | { type: "playback"; utteranceId: string; language: string; lagMs: number }
  | { type: "cache"; readyStopIds: string[] };

export type GuestSummary = {
  id: string;
  language: string | null;
  connectedAt: string;
  cachedStops: number;
};

export type StopLanguageStatus = { code: string; ok: boolean; error?: string };

export type StopSummary = {
  id: string;
  name: string;
  script?: string;
  languages: StopLanguageStatus[];
};

export type PublicStop = { id: string; name: string };

export type LanguageOffer = {
  code: LangCode;
  name: string;
  native: string;
  dir: "ltr" | "rtl";
  live: boolean;
  scripts: boolean;
  note?: string;
};

export type UsageKind = "stt" | "mt" | "tts" | "live";

export type UsageEvent = {
  at: string;
  provider: string;
  kind: UsageKind;
  language?: string;
  audioInputSeconds: number;
  audioOutputSeconds: number;
  charactersIn: number;
  charactersOut: number;
  estimatedUsd: number;
  note?: string;
};

export type LatencySample = {
  at: string;
  utteranceId: string;
  language: string;
  pipelineMs: number;
  deliveryMs?: number;
  estimatedAtEarMs?: number;
  early: boolean;
};

export type StatusLogEntry = {
  at: string;
  state: LinkState;
  online: boolean;
  rttMs: number | null;
  signal: SignalLevel | null;
  guestCount: number;
  broadcasting: boolean;
};

export type MetricsSnapshot = {
  sessionStartedAt: string;
  provider: string;
  droppedConnections: number;
  guestDisconnects: number;
  statusLog: StatusLogEntry[];
  latency: LatencySample[];
  usage: UsageEvent[];
  estimatedUsd: number;
  totals: {
    audioInputSeconds: number;
    audioOutputSeconds: number;
    charactersIn: number;
    charactersOut: number;
  };
};

export type ServerMessage =
  | {
      type: "welcome";
      role: "guide" | "guest";
      code: string;
      joinUrl: string;
      maxGuests: number;
      provider: { id: string; label: string };
      languages: LanguageOffer[];
      glossary: string[];
      stops: StopSummary[];
      guests: GuestSummary[];
      broadcasting: boolean;
      storeAudio: boolean;
    }
  | { type: "guests"; guests: GuestSummary[] }
  | { type: "stops"; stops: StopSummary[] }
  | {
      type: "caption";
      utteranceId: string;
      track: "source" | "translation";
      language: string;
      text: string;
      final: boolean;
    }
  | {
      type: "audio";
      utteranceId: string;
      language: string;
      mime: "audio/wav" | "audio/pcm";
      sampleRate: number;
      data: string;
      seq: number;
      end: boolean;
      speechEndedAt: number;
    }
  | { type: "status"; state: LinkState; detail: string }
  | {
      type: "play-stop";
      stopId: string;
      name: string;
      language: string;
      caption: string;
      audioUrl: string;
    }
  | {
      type: "question";
      guestId: string;
      language: string;
      original: string;
      english: string;
      mime?: "audio/wav";
      audio?: string;
    }
  | { type: "pipelines"; languages: string[] }
  | { type: "metrics"; snapshot: MetricsSnapshot }
  | { type: "pong"; t: number }
  | { type: "error"; message: string };

export type HelloGuide = Extract<ClientMessage, { type: "hello"; role: "guide" }>;
export type HelloGuest = Extract<ClientMessage, { type: "hello"; role: "guest" }>;
