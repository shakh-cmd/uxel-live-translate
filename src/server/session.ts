import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import { LANGUAGES, isLangCode } from "../shared/languages";
import type { ClientMessage, GuestSummary, ServerMessage, StopSummary } from "../shared/protocol";
import type { Config } from "./config";
import { LanguageFanout } from "./fanout";
import { log } from "./log";
import { SessionMetrics } from "./metrics";
import { languageOffers, type TranslationProvider } from "./providers";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function makeCode(length = 6): string {
  const bytes = randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i += 1) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

type Render =
  | { ok: true; caption: string; audio: Buffer; mime: "audio/wav" | "audio/pcm" }
  | { ok: false; error: string };

type Stop = {
  id: string;
  name: string;
  script: string;
  renders: Map<string, Render>;
};

type GuestConn = {
  id: string;
  ws: WebSocket;
  language: string | null;
  connectedAt: string;
  cachedStops: number;
};

export class TourSession {
  readonly createdAt = new Date().toISOString();
  readonly metrics: SessionMetrics;
  readonly fanout: LanguageFanout;
  broadcasting = false;
  private guide: WebSocket | null = null;
  private guideId = "";
  private guests = new Map<string, GuestConn>();
  private sockets = new Map<WebSocket, { role: "guide" | "guest"; id: string }>();
  private stops = new Map<string, Stop>();
  private timer: NodeJS.Timeout;
  closed = false;

  constructor(
    readonly code: string,
    private joinBase: string,
    private config: Config,
    private provider: TranslationProvider,
  ) {
    this.metrics = new SessionMetrics(provider.id);
    this.fanout = new LanguageFanout(provider, config.glossary, {
      toGuest: (guestId, message) => {
        const guest = this.guests.get(guestId);
        if (guest) this.send(guest.ws, message);
      },
      toGuide: (message) => this.sendGuide(message),
      onUsage: (usage) => {
        this.metrics.addUsage(usage);
      },
      onLatency: (sample) => {
        this.metrics.addLatency(sample);
        this.pushStatus();
      },
    });
    this.timer = setInterval(() => this.logStatus(), 10_000);
    this.timer.unref?.();
  }

  joinUrl(): string {
    return `${this.joinBase}/g/${this.code}`;
  }

  attachGuide(ws: WebSocket, clientId: string): void {
    if (this.guide && this.guide !== ws) this.guide.close(1000, "replaced");
    this.guide = ws;
    this.guideId = clientId;
    this.sockets.set(ws, { role: "guide", id: clientId });
    this.metrics.guideOnline = true;
    this.sendGuide(this.welcome("guide"));
    this.pushStatus();
    this.logStatus();
    log("guide-connected", { code: this.code });
  }

  attachGuest(ws: WebSocket, clientId: string, language?: string): boolean {
    const existing = this.guests.get(clientId);
    if (!existing && this.guests.size >= this.config.maxGuests) return false;
    if (existing && existing.ws !== ws) existing.ws.close(1000, "replaced");
    const guest: GuestConn = existing
      ? { ...existing, ws }
      : { id: clientId, ws, language: null, connectedAt: new Date().toISOString(), cachedStops: 0 };
    this.guests.set(clientId, guest);
    this.sockets.set(ws, { role: "guest", id: clientId });
    const initial = language && isLangCode(language) && this.provider.supports(language).live ? language : null;
    if (initial) {
      guest.language = initial;
      this.fanout.addGuest(clientId, initial);
    } else if (!existing) {
      this.fanout.addGuest(clientId, null);
    }
    this.send(ws, this.welcome("guest"));
    this.sendGuide({ type: "guests", guests: this.guestSummaries() });
    log("guest-connected", { code: this.code, language: guest.language, guests: this.guests.size });
    return true;
  }

  detach(ws: WebSocket, closeCode: number): void {
    const who = this.sockets.get(ws);
    this.sockets.delete(ws);
    if (!who) return;
    if (who.role === "guide") {
      if (this.guide === ws) {
        this.guide = null;
        this.metrics.guideOnline = false;
        this.pushStatus();
        this.logStatus();
        if (closeCode !== 1000 && closeCode !== 1001) this.metrics.droppedConnections += 1;
        log("guide-disconnected", { code: this.code, closeCode });
      }
      return;
    }
    const guest = this.guests.get(who.id);
    if (!guest || guest.ws !== ws) return;
    this.guests.delete(who.id);
    this.fanout.removeGuest(who.id);
    this.metrics.guestDisconnects += 1;
    if (closeCode !== 1000 && closeCode !== 1001) this.metrics.droppedConnections += 1;
    this.sendGuide({ type: "guests", guests: this.guestSummaries() });
    log("guest-disconnected", { code: this.code, closeCode, guests: this.guests.size });
  }

  async onMessage(ws: WebSocket, message: ClientMessage): Promise<void> {
    const who = this.sockets.get(ws);
    if (!who) return;
    if (who.role === "guide") await this.onGuide(message);
    else await this.onGuest(who.id, message);
  }

  async renderStop(name: string, script: string): Promise<StopSummary> {
    const stop: Stop = { id: randomUUID(), name: name.trim(), script: script.trim(), renders: new Map() };
    const langs = LANGUAGES.filter((lang) => this.provider.supports(lang.code).scripts);
    await mapPool(langs, 3, async (lang) => {
      try {
        const translated = await this.provider.translate(stop.script, lang.code, this.config.glossary);
        if (translated.usage) this.metrics.addUsage(translated.usage);
        const audio = await this.provider.synthesize(translated.text, lang.code);
        if (audio.usage) this.metrics.addUsage(audio.usage);
        stop.renders.set(lang.code, { ok: true, caption: translated.text, audio: audio.bytes, mime: audio.mime });
        if (this.config.storeAudio) {
          const dir = path.join("data", "sessions", this.code, stop.id);
          await mkdir(dir, { recursive: true });
          await writeFile(path.join(dir, `${lang.code}.wav`), audio.bytes);
        }
      } catch (error) {
        stop.renders.set(lang.code, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
    this.stops.set(stop.id, stop);
    const summary = this.stopSummary(stop, true);
    this.sendGuide({ type: "stops", stops: this.stopSummaries(true) });
    for (const guest of this.guests.values()) this.send(guest.ws, { type: "stops", stops: this.stopSummaries(false) });
    log("stop-ready", { code: this.code, name: stop.name, languages: summary.languages.filter((l) => l.ok).length });
    return summary;
  }

  audioFor(stopId: string, lang: string): Render | undefined {
    return this.stops.get(stopId)?.renders.get(lang);
  }

  captionFor(stopId: string, lang: string): string | undefined {
    const render = this.audioFor(stopId, lang);
    return render?.ok ? render.caption : undefined;
  }

  publicStops(): { id: string; name: string }[] {
    return [...this.stops.values()].map((stop) => ({ id: stop.id, name: stop.name }));
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.fanout.close();
    const message: ServerMessage = { type: "error", message: "The guide ended this tour." };
    for (const guest of this.guests.values()) {
      this.send(guest.ws, message);
      guest.ws.close(1000, "ended");
    }
    this.guide?.close(1000, "ended");
    this.stops.clear();
    log("session-ended", { code: this.code });
  }

  private async onGuide(message: ClientMessage): Promise<void> {
    if (message.type === "broadcast") {
      this.broadcasting = message.action === "start";
      this.pushStatus();
      this.logStatus();
      return;
    }
    if (message.type === "audio") {
      if (!this.broadcasting) return;
      const pcm = message.pcm ? decodePcm(message.pcm) : null;
      if (pcm) this.fanout.pushPcm(pcm, message.utteranceId);
      if (message.end) {
        await this.fanout.endUtterance({
          utteranceId: message.utteranceId,
          hint: message.hint,
          speechEndedAt: Date.now(),
        });
      }
      return;
    }
    if (message.type === "demo") {
      if (!this.broadcasting) {
        this.sendGuide({ type: "error", message: "Start the broadcast before the demo line." });
        return;
      }
      const utteranceId = `demo-${Date.now()}`;
      await this.fanout.endUtterance({ utteranceId, hint: message.text, speechEndedAt: Date.now() });
      return;
    }
    if (message.type === "play-stop") {
      this.playStop(message.stopId);
      return;
    }
    if (message.type === "heartbeat") {
      this.metrics.lastRttMs = message.rttMs ?? this.metrics.lastRttMs;
      this.metrics.lastSignal = message.signal ?? this.metrics.lastSignal;
      this.metrics.guideOnline = message.online && Boolean(this.guide);
      this.sendGuide({ type: "pong", t: Date.now() });
      this.pushStatus();
      return;
    }
  }

  private async onGuest(id: string, message: ClientMessage): Promise<void> {
    const guest = this.guests.get(id);
    if (!guest) return;
    if (message.type === "language") {
      if (!isLangCode(message.language) || !this.provider.supports(message.language).live) {
        this.send(guest.ws, { type: "error", message: "That language is not available on this tour." });
        return;
      }
      guest.language = message.language;
      this.fanout.setLanguage(id, message.language);
      this.sendGuide({ type: "guests", guests: this.guestSummaries() });
      return;
    }
    if (message.type === "question") {
      const pcm = message.pcm ? decodePcm(message.pcm) : Buffer.alloc(0);
      if (!pcm && !message.hint?.trim()) return;
      await this.fanout.handleQuestion(id, message.language || guest.language || "en", pcm ?? Buffer.alloc(0), message.hint);
      return;
    }
    if (message.type === "playback") {
      this.metrics.notePlayback(message.utteranceId, message.language, message.lagMs, this.metrics.lastRttMs);
      return;
    }
    if (message.type === "cache") {
      guest.cachedStops = message.readyStopIds.length;
      this.sendGuide({ type: "guests", guests: this.guestSummaries() });
      return;
    }
    if (message.type === "heartbeat") {
      this.send(guest.ws, { type: "pong", t: Date.now() });
    }
  }

  private playStop(stopId: string): void {
    const stop = this.stops.get(stopId);
    if (!stop) {
      this.sendGuide({ type: "error", message: "That stop is not on this tour." });
      return;
    }
    for (const guest of this.guests.values()) {
      if (!guest.language) continue;
      const render = stop.renders.get(guest.language);
      if (!render?.ok) {
        this.send(guest.ws, { type: "error", message: `No saved audio yet for ${stop.name}.` });
        continue;
      }
      this.send(guest.ws, {
        type: "play-stop",
        stopId: stop.id,
        name: stop.name,
        language: guest.language,
        caption: render.caption,
        audioUrl: `/api/session/${this.code}/audio/${stop.id}/${guest.language}`,
      });
    }
    log("play-stop", { code: this.code, name: stop.name, guests: this.guests.size });
  }

  private welcome(role: "guide" | "guest"): ServerMessage {
    return {
      type: "welcome",
      role,
      code: this.code,
      joinUrl: this.joinUrl(),
      maxGuests: this.config.maxGuests,
      provider: { id: this.provider.id, label: this.provider.label },
      languages: languageOffers(this.provider),
      glossary: role === "guide" ? this.config.glossary : [],
      stops: this.stopSummaries(role === "guide"),
      guests: role === "guide" ? this.guestSummaries() : [],
      broadcasting: this.broadcasting,
      storeAudio: this.config.storeAudio,
    };
  }

  private guestSummaries(): GuestSummary[] {
    return [...this.guests.values()].map((guest) => ({
      id: guest.id,
      language: guest.language,
      connectedAt: guest.connectedAt,
      cachedStops: guest.cachedStops,
    }));
  }

  private stopSummaries(includeScript: boolean): StopSummary[] {
    return [...this.stops.values()].map((stop) => this.stopSummary(stop, includeScript));
  }

  private stopSummary(stop: Stop, includeScript: boolean): StopSummary {
    return {
      id: stop.id,
      name: stop.name,
      script: includeScript ? stop.script : undefined,
      languages: LANGUAGES.map((lang) => {
        const render = stop.renders.get(lang.code);
        if (!render) return { code: lang.code, ok: false, error: "not rendered" };
        return render.ok ? { code: lang.code, ok: true } : { code: lang.code, ok: false, error: render.error };
      }),
    };
  }

  private logStatus(): void {
    const entry = this.metrics.logStatus({
      guestCount: this.guests.size,
      broadcasting: this.broadcasting,
      online: this.metrics.guideOnline,
      rttMs: this.metrics.lastRttMs,
      signal: this.metrics.lastSignal,
    });
    log("guide-status", { code: this.code, ...entry });
    this.sendGuide({ type: "metrics", snapshot: this.metrics.snapshot() });
  }

  private pushStatus(): void {
    const state = this.metrics.state();
    const detail =
      state === "offline"
        ? "Guide link is down."
        : state === "lagging"
          ? "The link or the last sentence is slow."
          : this.broadcasting
            ? "Live. Guests can hear you."
            : "Connected. Broadcast is stopped.";
    this.sendGuide({ type: "status", state, detail });
  }

  private sendGuide(message: ServerMessage): void {
    this.send(this.guide, message);
  }

  private send(ws: WebSocket | null, message: ServerMessage): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }
}

export class SessionStore {
  private sessions = new Map<string, TourSession>();

  constructor(
    private config: Config,
    private provider: TranslationProvider,
  ) {}

  create(joinBase: string): TourSession {
    let code = makeCode();
    while (this.sessions.has(code)) code = makeCode();
    const session = new TourSession(code, joinBase, this.config, this.provider);
    this.sessions.set(code, session);
    log("session-created", { code, provider: this.provider.id });
    return session;
  }

  get(code: string): TourSession | undefined {
    return this.sessions.get(code.toUpperCase());
  }

  end(code: string): void {
    const session = this.get(code);
    if (!session) return;
    session.end();
    this.sessions.delete(session.code);
  }
}

function decodePcm(value: string): Buffer | null {
  if (!value) return null;
  try {
    const buffer = Buffer.from(value, "base64");
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

async function mapPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await task(current);
    }
  });
  await Promise.all(workers);
}
