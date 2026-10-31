import { Mic, Radio, Square } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { DEMO_LINE, SAMPLE_STOP } from "../shared/demo";
import type { GuestSummary, LanguageOffer, LinkState, MetricsSnapshot, ServerMessage, StopSummary } from "../shared/protocol";
import { Brand, Footer } from "./brand";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { base64ToBytes, blobFrom, clientId } from "./lib";
import { MicCapture } from "./mic";
import { TourPlayer } from "./player";
import { connectTour, type LiveSocket } from "./socket";

type Question = { id: string; language: string; original: string; english: string };

const STATUS_LABEL: Record<LinkState, string> = {
  connected: "Connected",
  lagging: "Lagging",
  offline: "Offline",
};

function signalNow(): "good" | "weak" | "none" {
  if (!navigator.onLine) return "none";
  const connection = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection;
  const kind = connection?.effectiveType;
  if (kind === "slow-2g" || kind === "2g") return "weak";
  return "good";
}

export function GuidePage() {
  const [pin, setPin] = useState(sessionStorage.getItem("guidePin") || "");
  const [code, setCode] = useState(sessionStorage.getItem("guideCode") || "");
  const [joinUrl, setJoinUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState(false);
  const [status, setStatus] = useState<LinkState>("offline");
  const [statusDetail, setStatusDetail] = useState("Sign in to open the tour.");
  const [broadcasting, setBroadcasting] = useState(false);
  const [caption, setCaption] = useState("");
  const [guests, setGuests] = useState<GuestSummary[]>([]);
  const [stops, setStops] = useState<StopSummary[]>([]);
  const [languages, setLanguages] = useState<LanguageOffer[]>([]);
  const [providerLabel, setProviderLabel] = useState("");
  const [glossary, setGlossary] = useState<string[]>([]);
  const [pipelines, setPipelines] = useState<string[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [stopName, setStopName] = useState("");
  const [stopScript, setStopScript] = useState("");
  const [rendering, setRendering] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState(localStorage.getItem("guideMic") || "");
  const [threshold, setThreshold] = useState(Number(localStorage.getItem("guideThreshold") || "0.02"));
  const [level, setLevel] = useState(0);
  const [hearing, setHearing] = useState(false);
  const [secure] = useState(window.isSecureContext);
  const socketRef = useRef<LiveSocket | null>(null);
  const broadcastRef = useRef(false);
  const micRef = useRef(new MicCapture());
  const playerRef = useRef<TourPlayer | null>(null);
  const rttRef = useRef<number | undefined>(undefined);
  const sentRef = useRef(0);

  useEffect(() => {
    playerRef.current = new TourPlayer();
    return () => micRef.current.stop();
  }, []);

  useEffect(() => {
    if (!code || !pin) return;
    const live = connectTour(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?role=guide&code=${code}`,
      { type: "hello", role: "guide", clientId: clientId("guideClient"), pin },
      (message) => onServer(message),
      (open) => {
        setLinked(open);
        if (open && broadcastRef.current) socketRef.current?.send({ type: "broadcast", action: "start" });
        if (!open) {
          setStatus("offline");
          setStatusDetail("Reconnecting to the tour…");
        }
      },
    );
    socketRef.current = live;
    const beat = window.setInterval(() => {
      sentRef.current = performance.now();
      live.send({ type: "heartbeat", online: navigator.onLine, rttMs: rttRef.current, signal: signalNow() });
    }, 5000);
    return () => {
      window.clearInterval(beat);
      live.close();
      if (socketRef.current === live) socketRef.current = null;
    };
    // The socket is rebuilt only when the tour code or PIN changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, pin]);

  function onServer(message: ServerMessage) {
    if (message.type === "welcome") {
      setJoinUrl(message.joinUrl);
      setGuests(message.guests);
      setStops(message.stops);
      setLanguages(message.languages);
      setProviderLabel(message.provider.label);
      setGlossary(message.glossary);
      setBroadcasting(message.broadcasting);
      setError("");
    } else if (message.type === "guests") setGuests(message.guests);
    else if (message.type === "stops") setStops(message.stops);
    else if (message.type === "pipelines") setPipelines(message.languages);
    else if (message.type === "status") {
      setStatus(message.state);
      setStatusDetail(message.detail);
    } else if (message.type === "caption" && message.track === "source") {
      setCaption(message.text);
    } else if (message.type === "question") {
      setQuestions((prev) =>
        [{ id: crypto.randomUUID(), language: message.language, original: message.original, english: message.english }, ...prev].slice(0, 8),
      );
      if (message.audio) {
        const blob = blobFrom(base64ToBytes(message.audio), "audio/wav");
        void playerRef.current?.unlock();
        playerRef.current?.enqueue(blob, message.guestId);
      }
    } else if (message.type === "metrics") setMetrics(message.snapshot);
    else if (message.type === "pong") rttRef.current = performance.now() - sentRef.current;
    else if (message.type === "error") setError(message.message);
  }

  async function createTour(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (code) {
        await fetch(`/api/guide/session/${code}/end`, { method: "POST", headers: { "x-guide-pin": pin } });
      }
      const response = await fetch("/api/guide/session", { method: "POST", headers: { "x-guide-pin": pin } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not start a tour.");
      sessionStorage.setItem("guidePin", pin);
      sessionStorage.setItem("guideCode", body.code);
      setCode(body.code);
      setJoinUrl(body.joinUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a tour.");
    } finally {
      setBusy(false);
    }
  }

  async function endTour() {
    if (!code) return;
    await fetch(`/api/guide/session/${code}/end`, { method: "POST", headers: { "x-guide-pin": pin } });
    micRef.current.stop();
    sessionStorage.removeItem("guideCode");
    setCode("");
    setBroadcasting(false);
    setGuests([]);
    setStops([]);
    setCaption("");
  }

  async function toggleBroadcast() {
    if (!broadcasting) {
      broadcastRef.current = true;
      setBroadcasting(true);
      socketRef.current?.send({ type: "broadcast", action: "start" });
      await playerRef.current?.unlock();
      if (secure) {
        try {
          await startMic();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Microphone blocked.");
        }
      }
    } else {
      broadcastRef.current = false;
      setBroadcasting(false);
      socketRef.current?.send({ type: "broadcast", action: "stop" });
      micRef.current.stop();
      setHearing(false);
      setLevel(0);
    }
  }

  async function startMic(nextDevice = deviceId) {
    const found = await micRef.current.listDevices();
    setDevices(found);
    await micRef.current.start({
      deviceId: nextDevice || undefined,
      threshold,
      language: "en-US",
      onLevel: (value, speaking) => {
        setLevel(value);
        setHearing(speaking);
      },
      onPcm: (frame) => socketRef.current?.send({ type: "audio", ...frame }),
    });
    setDevices(await micRef.current.listDevices());
  }

  async function createStop(event: FormEvent) {
    event.preventDefault();
    setRendering(true);
    setError("");
    try {
      const response = await fetch(`/api/guide/session/${code}/stops`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-guide-pin": pin },
        body: JSON.stringify({ name: stopName, script: stopScript }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not prepare that stop.");
      setStopName("");
      setStopScript("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not prepare that stop.");
    } finally {
      setRendering(false);
    }
  }

  async function download(kind: "json" | "csv") {
    const response = await fetch(`/api/guide/session/${code}/export.${kind}`, { headers: { "x-guide-pin": pin } });
    if (!response.ok) {
      setError("Could not export the log.");
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `tourmania-${code}.${kind}`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const shownStatus: LinkState = code && linked ? status : "offline";

  return (
    <div className="safe-pad min-h-dvh">
      <Brand subtitle="Guide desk" />
      <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-5">
        {!code ? (
          <Card>
            <CardTitle>Open the tour</CardTitle>
            <p className="mt-2 text-sm font-semibold leading-relaxed text-brand-navy/80">
              This page is for the guide. Guests only scan the QR code. The PIN is the one set on the server.
            </p>
            <form className="mt-4 flex flex-col gap-3" onSubmit={createTour}>
              <Input
                data-testid="guide-pin"
                inputMode="numeric"
                autoComplete="current-password"
                placeholder="Guide PIN"
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                aria-label="Guide PIN"
              />
              <Button type="submit" size="lg" disabled={busy || pin.length < 4} data-testid="guide-create">
                {busy ? "Opening…" : "Start a tour"}
              </Button>
            </form>
          </Card>
        ) : (
          <>
            <div
              data-testid="guide-status"
              className={`flex items-center gap-4 rounded-3xl px-4 py-4 shadow-card ${
                shownStatus === "connected" ? "bg-brand-blue text-white" : shownStatus === "lagging" ? "bg-brand-yellow text-brand-navy" : "bg-brand-red text-white"
              }`}
            >
              <div className="grid h-20 w-20 shrink-0 place-items-center rounded-full bg-white/15 text-center text-xs font-extrabold uppercase leading-tight">
                {STATUS_LABEL[shownStatus]}
              </div>
              <div>
                <p className="text-2xl font-extrabold leading-none">{STATUS_LABEL[shownStatus]}</p>
                <p className="mt-2 text-sm font-bold leading-snug opacity-90">{statusDetail}</p>
              </div>
            </div>

            <Button
              type="button"
              size="lg"
              variant={broadcasting ? "danger" : "navy"}
              data-testid={broadcasting ? "guide-stop" : "guide-start"}
              onClick={() => void toggleBroadcast()}
            >
              {broadcasting ? <Square className="h-5 w-5" /> : <Radio className="h-5 w-5" />}
              {broadcasting ? "Stop broadcast" : "Start broadcast"}
            </Button>

            {!secure && (
              <p className="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-brand-navy">
                This browser will block the microphone until the page is HTTPS. The demo line still works. On the Samsung, the guide app can use the mic without that limit.
              </p>
            )}

            <Card>
              <CardTitle>Microphone</CardTitle>
              <div className="mt-3 h-3 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full bg-brand-red transition-all" style={{ width: `${Math.min(100, level * 400)}%` }} />
              </div>
              <p className="mt-2 text-sm font-extrabold text-brand-navy" data-testid="guide-vad">
                {hearing ? "Hearing you — sending audio" : broadcasting ? "Quiet — not sending" : "Broadcast is stopped"}
              </p>
              <label className="mt-3 block text-xs font-extrabold uppercase tracking-wide text-brand-navy/60">
                Ignore noise below
                <input
                  className="mt-1 w-full"
                  type="range"
                  min={0.005}
                  max={0.08}
                  step={0.001}
                  value={threshold}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setThreshold(value);
                    localStorage.setItem("guideThreshold", String(value));
                  }}
                />
              </label>
              <label className="mt-3 block text-xs font-extrabold uppercase tracking-wide text-brand-navy/60">
                Mic
                <select
                  className="mt-1 min-h-12 w-full rounded-2xl border-2 border-slate-200 px-3 font-bold"
                  value={deviceId}
                  onChange={(event) => {
                    setDeviceId(event.target.value);
                    localStorage.setItem("guideMic", event.target.value);
                    if (broadcasting && secure) void startMic(event.target.value).catch((err) => setError(String(err)));
                  }}
                >
                  <option value="">Phone microphone</option>
                  {devices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || "Microphone"}
                    </option>
                  ))}
                </select>
              </label>
              <p className="mt-2 text-xs font-semibold text-brand-navy/60">
                USB-C and Bluetooth mics appear here after the broadcast starts, if the phone exposes them to Chrome.
              </p>
            </Card>

            <Card>
              <CardTitle>English captions</CardTitle>
              <p className="mt-2 min-h-16 text-xl font-extrabold leading-snug" data-testid="guide-caption">
                {caption || "Captions appear when you speak, or when you send the demo line."}
              </p>
              <Button
                type="button"
                variant="yellow"
                className="mt-3 w-full"
                data-testid="guide-demo"
                onClick={() => socketRef.current?.send({ type: "demo", text: DEMO_LINE })}
              >
                <Mic className="h-4 w-4" />
                Send demo line
              </Button>
            </Card>

            <Card>
              <CardTitle>Guests · {guests.length}</CardTitle>
              <p className="mt-1 text-xs font-bold text-brand-navy/60" data-testid="guide-pipelines">
                Live pipelines: {pipelines.length ? pipelines.join(", ") : "none yet"}
              </p>
              <ul className="mt-3 flex flex-col gap-2" data-testid="guide-guests">
                {guests.length === 0 && <li className="text-sm font-semibold text-brand-navy/60">Waiting for the first phone.</li>}
                {guests.map((guest) => (
                  <li key={guest.id} className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2">
                    <span className="font-extrabold">{guest.language || "Choosing…"}</span>
                    <span className="text-xs font-bold text-brand-navy/60">{guest.cachedStops} stops saved</span>
                  </li>
                ))}
              </ul>
            </Card>

            <Card>
              <CardTitle>Guest QR</CardTitle>
              <p className="mt-1 text-sm font-semibold text-brand-navy/70">They scan this. Nothing to install.</p>
              <img
                data-testid="guide-qr"
                alt="QR code for guests to join this tour"
                className="mx-auto mt-3 w-56 rounded-2xl border border-slate-100"
                src={`/api/session/${code}/qr.png`}
              />
              <p className="mt-3 text-center text-3xl font-extrabold tracking-[0.25em]" data-testid="guide-code">
                {code}
              </p>
              <p className="break-all text-center text-xs font-bold text-brand-blue">{joinUrl}</p>
            </Card>

            <Card>
              <CardTitle>Recorded stops</CardTitle>
              <p className="mt-2 text-sm font-semibold leading-relaxed text-brand-navy/75">
                Write the English you would say at a dead zone, such as the Basilica Cistern. The server prepares every language now. Guests save it on the phone. Tap the stop to play it together, even if the signal is gone for them.
              </p>
              <form className="mt-3 flex flex-col gap-3" onSubmit={createStop}>
                <Input data-testid="stop-name" placeholder="Stop name" value={stopName} onChange={(event) => setStopName(event.target.value)} />
                <Textarea
                  data-testid="stop-script"
                  placeholder="English script"
                  value={stopScript}
                  onChange={(event) => setStopScript(event.target.value)}
                />
                <Button type="button" variant="outline" onClick={() => { setStopName(SAMPLE_STOP.name); setStopScript(SAMPLE_STOP.script); }}>
                  Use Basilica Cistern example
                </Button>
                <Button type="submit" disabled={rendering || !stopName.trim() || !stopScript.trim()} data-testid="stop-create">
                  {rendering ? "Preparing languages…" : "Prepare this stop"}
                </Button>
              </form>
              <div className="mt-4 flex flex-col gap-2">
                {stops.map((stop) => {
                  const ready = stop.languages.filter((lang) => lang.ok).length;
                  return (
                    <Button
                      key={stop.id}
                      type="button"
                      variant="yellow"
                      className="h-auto flex-col py-3"
                      data-testid={`stop-${stop.id}`}
                      onClick={() => socketRef.current?.send({ type: "play-stop", stopId: stop.id })}
                    >
                      <span>{stop.name}</span>
                      <span className="text-xs font-bold">{ready}/{stop.languages.length} languages ready</span>
                    </Button>
                  );
                })}
              </div>
            </Card>

            <Card>
              <CardTitle>Guest questions</CardTitle>
              <ul className="mt-3 flex flex-col gap-3" data-testid="guide-questions">
                {questions.length === 0 && <li className="text-sm font-semibold text-brand-navy/60">None yet.</li>}
                {questions.map((question) => (
                  <li key={question.id} className="rounded-2xl bg-slate-50 p-3">
                    <p className="text-xs font-extrabold uppercase text-brand-navy/50">{question.language}</p>
                    <p className="font-semibold">{question.original}</p>
                    <p className="mt-1 font-extrabold">{question.english}</p>
                  </li>
                ))}
              </ul>
            </Card>

            <Card>
              <CardTitle>Pilot log</CardTitle>
              <p className="mt-2 text-sm font-semibold text-brand-navy/80">
                Provider: {providerLabel || "…"}. Estimated session cost {metrics ? `$${metrics.estimatedUsd.toFixed(4)}` : "$0.0000"}.
                Dropped links: {metrics?.droppedConnections ?? 0}.
              </p>
              {metrics && metrics.latency.length > 0 && (
                <ul className="mt-2 text-sm font-bold">
                  {latestByLanguage(metrics).map((sample) => (
                    <li key={sample.language}>
                      {sample.language}: {sample.early ? "already speaking" : `${(sample.estimatedAtEarMs ?? sample.pipelineMs).toFixed(0)} ms`}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button type="button" variant="outline" onClick={() => void download("csv")}>CSV</Button>
                <Button type="button" variant="outline" onClick={() => void download("json")}>JSON</Button>
              </div>
            </Card>

            <Card>
              <CardTitle>Languages on this provider</CardTitle>
              <div className="mt-3 flex flex-wrap gap-2">
                {languages.map((lang) => (
                  <Badge key={lang.code} className={lang.live ? "bg-brand-blue/10 text-brand-blue" : "bg-brand-red/10 text-brand-red"}>
                    {lang.native} {lang.live ? "live" : "no"}
                  </Badge>
                ))}
              </div>
              {languages[0]?.note && <p className="mt-3 text-xs font-semibold leading-relaxed text-brand-navy/70">{languages[0].note}</p>}
              <p className="mt-3 text-xs font-semibold leading-relaxed text-brand-navy/70">
                Names kept as written: {glossary.join(", ") || "none"}.
              </p>
            </Card>

            <Button type="button" variant="ghost" onClick={() => void endTour()}>
              End tour
            </Button>
          </>
        )}
        {error && (
          <p className="rounded-2xl bg-brand-red px-4 py-3 text-sm font-extrabold text-white" data-testid="guide-error">
            {error}
          </p>
        )}
      </main>
      <Footer />
    </div>
  );
}

function latestByLanguage(metrics: MetricsSnapshot) {
  const map = new Map<string, MetricsSnapshot["latency"][number]>();
  for (const sample of metrics.latency) map.set(sample.language, sample);
  return [...map.values()];
}
