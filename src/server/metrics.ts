import {
  connectionState,
  type LatencySample,
  type LinkState,
  type MetricsSnapshot,
  type SignalLevel,
  type StatusLogEntry,
  type UsageEvent,
} from "../shared/protocol";

export class SessionMetrics {
  readonly startedAt = new Date().toISOString();
  droppedConnections = 0;
  guestDisconnects = 0;
  readonly statusLog: StatusLogEntry[] = [];
  readonly latency: LatencySample[] = [];
  readonly usage: UsageEvent[] = [];
  lastPipelineMs: number | null = null;
  lastEarly = false;
  lastRttMs: number | null = null;
  lastSignal: SignalLevel | null = null;
  guideOnline = false;

  constructor(private providerId: string) {}

  addUsage(partial: Omit<UsageEvent, "at">): void {
    this.usage.push({ ...partial, at: new Date().toISOString() });
  }

  addLatency(sample: Omit<LatencySample, "at">): void {
    const row: LatencySample = { ...sample, at: new Date().toISOString() };
    const existing = this.latency.find((s) => s.utteranceId === sample.utteranceId && s.language === sample.language);
    if (existing) {
      existing.pipelineMs = sample.pipelineMs;
      existing.early = sample.early;
      if (sample.deliveryMs != null) existing.deliveryMs = sample.deliveryMs;
      if (sample.estimatedAtEarMs != null) existing.estimatedAtEarMs = sample.estimatedAtEarMs;
    } else {
      this.latency.push(row);
    }
    this.lastPipelineMs = sample.pipelineMs;
    this.lastEarly = sample.early;
  }

  notePlayback(utteranceId: string, language: string, lagMs: number, rttMs: number | null): void {
    const row = this.latency.find((s) => s.utteranceId === utteranceId && s.language === language);
    if (!row) return;
    row.deliveryMs = row.pipelineMs + Math.max(0, lagMs);
    row.estimatedAtEarMs = row.deliveryMs + (rttMs != null ? rttMs / 2 : 0);
  }

  logStatus(input: {
    guestCount: number;
    broadcasting: boolean;
    online: boolean;
    rttMs?: number | null;
    signal?: SignalLevel | null;
  }): StatusLogEntry {
    if (input.rttMs != null) this.lastRttMs = input.rttMs;
    if (input.signal != null) this.lastSignal = input.signal;
    this.guideOnline = input.online;
    const state = this.state();
    const entry: StatusLogEntry = {
      at: new Date().toISOString(),
      state,
      online: input.online,
      rttMs: this.lastRttMs,
      signal: this.lastSignal,
      guestCount: input.guestCount,
      broadcasting: input.broadcasting,
    };
    this.statusLog.push(entry);
    return entry;
  }

  state(): LinkState {
    return connectionState({
      online: this.guideOnline,
      rttMs: this.lastRttMs,
      lastPipelineMs: this.lastPipelineMs,
      early: this.lastEarly,
    });
  }

  snapshot(): MetricsSnapshot {
    const totals = this.usage.reduce(
      (acc, row) => {
        acc.audioInputSeconds += row.audioInputSeconds;
        acc.audioOutputSeconds += row.audioOutputSeconds;
        acc.charactersIn += row.charactersIn;
        acc.charactersOut += row.charactersOut;
        return acc;
      },
      { audioInputSeconds: 0, audioOutputSeconds: 0, charactersIn: 0, charactersOut: 0 },
    );
    const estimatedUsd = this.usage.reduce((sum, row) => sum + row.estimatedUsd, 0);
    return {
      sessionStartedAt: this.startedAt,
      provider: this.providerId,
      droppedConnections: this.droppedConnections,
      guestDisconnects: this.guestDisconnects,
      statusLog: this.statusLog,
      latency: this.latency,
      usage: this.usage,
      estimatedUsd,
      totals,
    };
  }
}

export function metricsToCsv(snapshot: MetricsSnapshot): string {
  const lines = [
    "section,at,language,utteranceId,state,online,rttMs,signal,guestCount,broadcasting,pipelineMs,deliveryMs,estimatedAtEarMs,early,provider,kind,audioInputSeconds,audioOutputSeconds,charactersIn,charactersOut,estimatedUsd,note",
  ];
  const cell = (value: unknown) => {
    const text = value == null ? "" : String(value);
    if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };
  const row = (values: unknown[]) => values.map(cell).join(",");
  for (const s of snapshot.statusLog) {
    lines.push(
      row([
        "status",
        s.at,
        "",
        "",
        s.state,
        s.online,
        s.rttMs,
        s.signal,
        s.guestCount,
        s.broadcasting,
        "",
        "",
        "",
        "",
        snapshot.provider,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ]),
    );
  }
  for (const s of snapshot.latency) {
    lines.push(
      row([
        "latency",
        s.at,
        s.language,
        s.utteranceId,
        "",
        "",
        "",
        "",
        "",
        "",
        s.pipelineMs.toFixed(0),
        s.deliveryMs?.toFixed(0) ?? "",
        s.estimatedAtEarMs?.toFixed(0) ?? "",
        s.early,
        snapshot.provider,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ]),
    );
  }
  for (const s of snapshot.usage) {
    lines.push(
      row([
        "usage",
        s.at,
        s.language ?? "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        s.provider,
        s.kind,
        s.audioInputSeconds.toFixed(2),
        s.audioOutputSeconds.toFixed(2),
        s.charactersIn,
        s.charactersOut,
        s.estimatedUsd.toFixed(6),
        s.note ?? "",
      ]),
    );
  }
  lines.push(
    row([
      "summary",
      snapshot.sessionStartedAt,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      snapshot.provider,
      "",
      snapshot.totals.audioInputSeconds.toFixed(2),
      snapshot.totals.audioOutputSeconds.toFixed(2),
      snapshot.totals.charactersIn,
      snapshot.totals.charactersOut,
      snapshot.estimatedUsd.toFixed(6),
      `dropped=${snapshot.droppedConnections}; disconnects=${snapshot.guestDisconnects}`,
    ]),
  );
  return lines.join("\n") + "\n";
}
