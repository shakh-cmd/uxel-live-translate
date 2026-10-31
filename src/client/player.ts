const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

/** Live audio further behind than this is skipped, so a guest never drifts minutes behind. */
export const MAX_LIVE_BACKLOG_SEC = 3;
const START_AHEAD_SEC = 0.08;

/**
 * Pure scheduling maths for gapless live audio, kept separate so it can be unit tested.
 * Returns when the chunk should start and whether the queued audio must be dropped first.
 */
export function planChunk(now: number, nextStart: number, maxBacklog = MAX_LIVE_BACKLOG_SEC): { start: number; skip: boolean } {
  if (nextStart < now + START_AHEAD_SEC) return { start: now + START_AHEAD_SEC, skip: false };
  if (nextStart - now > maxBacklog) return { start: now + START_AHEAD_SEC, skip: true };
  return { start: nextStart, skip: false };
}

/**
 * Live translation arrives as ~250 ms PCM chunks. The old player made each one a WAV file
 * and played it with one <audio> element. Every clip switch added a small gap, the gaps
 * piled up into minutes of delay, and "tap to resume" replayed the clip that had just
 * ended. Now live PCM is scheduled back to back on an AudioContext (no gaps, nothing is
 * ever replayed) and the backlog is capped. The <audio> element is only used for whole
 * files such as pre-recorded stops and guest questions.
 */
export class TourPlayer {
  private audio = new Audio();
  private files: { url: string; utteranceId?: string }[] = [];
  private filePlaying = false;
  private ctx: AudioContext | null = null;
  private nextStart = 0;
  private live = new Set<AudioBufferSourceNode>();
  unlocked = false;
  skippedSec = 0;
  private seen = new Set<string>();
  private wakeLock: WakeLockSentinel | null = null;
  onInterrupted: () => void = () => undefined;
  onStarted: (utteranceId: string, lagMs: number) => void = () => undefined;
  private receivedAt = new Map<string, number>();

  constructor() {
    this.audio.setAttribute("playsinline", "true");
    this.audio.preload = "auto";
    this.audio.onended = () => this.nextFile();
    this.audio.onerror = () => {
      if (this.filePlaying) this.nextFile();
    };
    this.audio.onpause = () => {
      if (document.visibilityState === "hidden" && this.unlocked && this.filePlaying && !this.audio.ended) this.onInterrupted();
    };
    this.audio.onplaying = () => this.started(this.audio.dataset.utterance || "", 0);
  }

  markReceived(utteranceId: string): void {
    if (!this.receivedAt.has(utteranceId)) this.receivedAt.set(utteranceId, performance.now());
    if (this.receivedAt.size > 200) this.receivedAt.delete(this.receivedAt.keys().next().value as string);
  }

  async unlock(): Promise<void> {
    this.unlocked = true;
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: "interactive" });
      this.ctx.onstatechange = () => {
        if (this.ctx && this.ctx.state !== "running" && this.unlocked) this.onInterrupted();
      };
    }
    try {
      await this.ctx.resume();
    } catch {
      /* resumed on the next tap */
    }
    if (!this.filePlaying) {
      this.audio.src = SILENT_WAV;
      void this.audio.play().catch(() => undefined);
    }
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      this.wakeLock = null;
    }
    this.pumpFiles();
  }

  get screenLockGranted(): boolean {
    return Boolean(this.wakeLock && !this.wakeLock.released);
  }

  get running(): boolean {
    return this.ctx?.state === "running";
  }

  /** Seconds of live audio queued ahead of the speaker. */
  get backlogSec(): number {
    if (!this.ctx) return 0;
    return Math.max(0, this.nextStart - this.ctx.currentTime);
  }

  /** Live 16-bit mono PCM chunk. */
  enqueuePcm(pcm: Uint8Array, sampleRate: number, utteranceId: string): void {
    const ctx = this.ctx;
    if (!ctx || !this.unlocked) return; // not listening yet: old speech is useless later
    const samples = Math.floor(pcm.byteLength / 2);
    if (!samples) return;
    const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
    const buffer = ctx.createBuffer(1, samples, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples; i += 1) channel[i] = view.getInt16(i * 2, true) / 32768;
    const plan = planChunk(ctx.currentTime, this.nextStart);
    if (plan.skip) {
      this.skippedSec += this.nextStart - ctx.currentTime;
      for (const node of this.live) {
        try {
          node.stop();
        } catch {
          /* already stopped */
        }
      }
      this.live.clear();
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => this.live.delete(source);
    source.start(plan.start);
    this.live.add(source);
    this.nextStart = plan.start + buffer.duration;
    this.started(utteranceId, (plan.start - ctx.currentTime) * 1000);
  }

  /** A whole file (pre-recorded stop, question). Played once, in order. */
  enqueue(blob: Blob, utteranceId?: string): void {
    const url = URL.createObjectURL(blob);
    this.files.push({ url, utteranceId });
    if (this.unlocked) this.pumpFiles();
  }

  /** Never replays anything: it only wakes up audio the phone paused. */
  resume(): void {
    if (this.ctx && this.ctx.state !== "running") void this.ctx.resume().catch(() => undefined);
    if (this.filePlaying && this.audio.paused && !this.audio.ended) void this.audio.play().catch(() => undefined);
    else this.pumpFiles();
  }

  private started(utteranceId: string, queuedMs: number): void {
    if (!utteranceId || this.seen.has(utteranceId)) return;
    this.seen.add(utteranceId);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value as string);
    const received = this.receivedAt.get(utteranceId) ?? performance.now();
    this.onStarted(utteranceId, Math.max(0, performance.now() - received + queuedMs));
    if (navigator.mediaSession) {
      navigator.mediaSession.playbackState = "playing";
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Tourmania Live Translate",
        artist: "Translated by AI",
        album: "Live tour",
      });
    }
  }

  private nextFile(): void {
    const finished = this.audio.src;
    this.filePlaying = false;
    if (finished.startsWith("blob:")) URL.revokeObjectURL(finished);
    this.pumpFiles();
  }

  private pumpFiles(): void {
    if (!this.unlocked || this.filePlaying || this.files.length === 0) return;
    const next = this.files.shift();
    if (!next) return;
    this.filePlaying = true;
    this.audio.dataset.utterance = next.utteranceId || "";
    this.audio.src = next.url;
    void this.audio.play().catch(() => {
      this.filePlaying = false;
      URL.revokeObjectURL(next.url);
      this.onInterrupted();
    });
  }
}
