const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

export class TourPlayer {
  private audio = new Audio();
  private queue: { url: string; utteranceId?: string }[] = [];
  private playing = false;
  unlocked = false;
  private seen = new Set<string>();
  private wakeLock: WakeLockSentinel | null = null;
  onInterrupted: () => void = () => undefined;
  onStarted: (utteranceId: string, lagMs: number) => void = () => undefined;
  private receivedAt = new Map<string, number>();

  constructor() {
    this.audio.setAttribute("playsinline", "true");
    this.audio.preload = "auto";
    this.audio.onended = () => {
      this.playing = false;
      this.pump();
    };
    this.audio.onpause = () => {
      if (document.visibilityState === "hidden" && this.unlocked) this.onInterrupted();
    };
    this.audio.onplaying = () => {
      const id = this.audio.dataset.utterance || "";
      if (!id || this.seen.has(id)) return;
      this.seen.add(id);
      const received = this.receivedAt.get(id) ?? performance.now();
      this.onStarted(id, Math.max(0, performance.now() - received));
      if (navigator.mediaSession) {
        navigator.mediaSession.playbackState = "playing";
        navigator.mediaSession.metadata = new MediaMetadata({
          title: "Tourmania Live Translate",
          artist: "Translated by AI",
          album: "Live tour",
        });
      }
    };
  }

  markReceived(utteranceId: string): void {
    if (!this.receivedAt.has(utteranceId)) this.receivedAt.set(utteranceId, performance.now());
  }

  async unlock(): Promise<void> {
    this.unlocked = true;
    this.audio.src = SILENT_WAV;
    try {
      await this.audio.play();
    } catch {
      /* the tap may still count once a real clip arrives */
    }
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      this.wakeLock = null;
    }
    this.pump();
  }

  get screenLockGranted(): boolean {
    return Boolean(this.wakeLock && !this.wakeLock.released);
  }

  enqueue(blob: Blob, utteranceId?: string): void {
    const url = URL.createObjectURL(blob);
    this.queue.push({ url, utteranceId });
    if (this.unlocked) this.pump();
  }

  resume(): void {
    if (this.audio.paused) void this.audio.play().catch(() => undefined);
    else this.pump();
  }

  private pump(): void {
    if (!this.unlocked || this.playing || this.queue.length === 0) return;
    const next = this.queue.shift();
    if (!next) return;
    this.playing = true;
    this.audio.dataset.utterance = next.utteranceId || "";
    this.audio.src = next.url;
    void this.audio.play().catch(() => {
      this.playing = false;
      this.onInterrupted();
    });
  }
}
