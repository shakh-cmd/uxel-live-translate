import { useEffect, useRef, useState } from "react";
import type { LanguageOffer, PublicStop, ServerMessage, StopSummary } from "../shared/protocol";
import { Brand, Footer } from "./brand";
import { Button } from "./components/ui/button";
import { Card, CardTitle } from "./components/ui/card";
import { base64ToBytes, blobFrom, clientId, iosDevice } from "./lib";
import { MicCapture } from "./mic";
import { TourPlayer } from "./player";
import { connectTour, type LiveSocket } from "./socket";

type SavedStop = { id: string; name: string; caption: string };

export function GuestPage({ code }: { code: string }) {
  const [languages, setLanguages] = useState<LanguageOffer[]>([]);
  const [language, setLanguage] = useState(sessionStorage.getItem(`guestLang-${code}`) || "");
  const [caption, setCaption] = useState("");
  const [listening, setListening] = useState(false);
  const [linked, setLinked] = useState(false);
  const [error, setError] = useState("");
  const [stops, setStops] = useState<StopSummary[]>([]);
  const [saved, setSaved] = useState<SavedStop[]>([]);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [paused, setPaused] = useState(false);
  const [screenLock, setScreenLock] = useState<boolean | null>(null);
  const [holding, setHolding] = useState(false);
  const [typed, setTyped] = useState("");
  const [asking, setAsking] = useState("");
  const socketRef = useRef<LiveSocket | null>(null);
  const playerRef = useRef<TourPlayer | null>(null);
  const micRef = useRef(new MicCapture());
  const chunks = useRef<Uint8Array[]>([]);
  const hintRef = useRef("");
  const holdTimer = useRef(0);
  const languageRef = useRef(language);
  languageRef.current = language;

  useEffect(() => {
    const link = document.getElementById("manifest-link") as HTMLLinkElement | null;
    if (link) link.href = `/manifest.webmanifest?start=${encodeURIComponent(`/g/${code}`)}`;
    const player = new TourPlayer();
    player.onInterrupted = () => setPaused(true);
    player.onStarted = (utteranceId, lagMs) => {
      setPaused(false);
      const chosen = languageRef.current;
      if (chosen) socketRef.current?.send({ type: "playback", utteranceId, language: chosen, lagMs });
    };
    playerRef.current = player;
    const onNet = () => setOffline(!navigator.onLine);
    window.addEventListener("online", onNet);
    window.addEventListener("offline", onNet);
    return () => {
      window.removeEventListener("online", onNet);
      window.removeEventListener("offline", onNet);
      micRef.current.stop();
    };
  }, [code]);

  useEffect(() => {
    setSaved(readSaved(code, language));
  }, [code, language]);

  useEffect(() => {
    const live = connectTour(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?role=guest&code=${encodeURIComponent(code)}`,
      { type: "hello", role: "guest", clientId: clientId(`guest-${code}`), language: language || undefined },
      onServer,
      (open) => {
        setLinked(open);
        if (open && languageRef.current) socketRef.current?.send({ type: "language", language: languageRef.current });
      },
    );
    socketRef.current = live;
    return () => live.close();
    // Reconnect when the tour code changes. Language updates go out as their own message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  function onServer(message: ServerMessage) {
    if (message.type === "welcome") {
      setLanguages(message.languages);
      setStops(message.stops);
      const chosen = languageRef.current;
      if (chosen) void prefetch(code, chosen, message.stops).then(reportCache);
    } else if (message.type === "stops") {
      setStops(message.stops);
      const chosen = languageRef.current;
      if (chosen) void prefetch(code, chosen, message.stops).then(reportCache);
    } else if (message.type === "caption" && message.track === "translation") {
      setCaption(message.text);
    } else if (message.type === "audio") {
      playerRef.current?.markReceived(message.utteranceId);
      const bytes = base64ToBytes(message.data);
      if (message.mime === "audio/pcm") playerRef.current?.enqueuePcm(bytes, message.sampleRate || 24000, message.utteranceId);
      else playerRef.current?.enqueue(blobFrom(bytes, "audio/wav"), message.utteranceId);
    } else if (message.type === "play-stop") {
      setCaption(message.caption);
      void playUrl(message.audioUrl, message.stopId);
    } else if (message.type === "error") setError(message.message);
  }

  async function choose(next: string) {
    languageRef.current = next;
    setLanguage(next);
    sessionStorage.setItem(`guestLang-${code}`, next);
    socketRef.current?.send({ type: "language", language: next });
    setCaption("");
    reportCache(await prefetch(code, next, stops));
  }

  function reportCache(savedStops: SavedStop[]) {
    setSaved(savedStops);
    socketRef.current?.send({ type: "cache", readyStopIds: savedStops.map((stop) => stop.id) });
  }

  async function listen() {
    await playerRef.current?.unlock();
    setListening(true);
    setScreenLock(playerRef.current?.screenLockGranted ?? false);
    setPaused(false);
  }

  async function playUrl(url: string, utteranceId: string) {
    const cache = await caches.open("tourmania-stops-v1");
    const hit = await cache.match(url);
    const response = hit || (await fetch(url));
    if (!response.ok) {
      setError("This stop is not saved on this phone yet.");
      return;
    }
    if (!hit) await cache.put(url, response.clone());
    const blob = await response.blob();
    if (!playerRef.current?.unlocked) await listen();
    playerRef.current?.enqueue(blob, utteranceId);
  }

  function beginQuestion(event: React.PointerEvent) {
    if (!window.isSecureContext || !language) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setHolding(true);
    chunks.current = [];
    hintRef.current = "";
    void micRef.current.start({
      threshold: 0.015,
      language: speechLang(language),
      onLevel: () => undefined,
      onPcm: (frame) => {
        if (frame.hint) hintRef.current = frame.hint;
        if (frame.pcm) chunks.current.push(base64ToBytes(frame.pcm));
      },
    });
    holdTimer.current = window.setTimeout(() => endQuestion(), 15_000);
  }

  function endQuestion() {
    if (!holding && chunks.current.length === 0) return;
    window.clearTimeout(holdTimer.current);
    micRef.current.stop();
    setHolding(false);
    const size = chunks.current.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks.current) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    chunks.current = [];
    const hint = hintRef.current;
    if (!merged.length && !hint) return;
    socketRef.current?.send({
      type: "question",
      language,
      utteranceId: crypto.randomUUID(),
      pcm: merged.length ? bytesToBase64(merged) : undefined,
      hint: hint || undefined,
    });
    setAsking("Sent to your guide.");
  }

  function sendTyped(event: React.FormEvent) {
    event.preventDefault();
    const hint = typed.trim();
    if (!hint || !language) return;
    socketRef.current?.send({ type: "question", language, utteranceId: crypto.randomUUID(), hint });
    setTyped("");
    setAsking("Sent to your guide.");
  }

  const selected = languages.find((item) => item.code === language);
  const savedCount = saved.length;

  return (
    <div className="safe-pad min-h-dvh">
      <Brand subtitle={selected ? selected.native : "Choose a language"} />
      <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-5">
        <p className={`rounded-full px-3 py-1 text-center text-xs font-extrabold uppercase tracking-wide ${linked ? "bg-brand-blue text-white" : "bg-brand-red text-white"}`}>
          {linked ? "Joined the tour" : offline ? "No signal" : "Joining…"}
        </p>

        {!language ? (
          <Card>
            <CardTitle>Your language</CardTitle>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {languages.map((item) => (
                <button
                  key={item.code}
                  type="button"
                  data-testid={`lang-${item.code}`}
                  disabled={!item.live}
                  dir={item.dir}
                  className="min-h-16 rounded-2xl bg-slate-50 px-3 text-left font-extrabold text-brand-navy disabled:opacity-40"
                  onClick={() => void choose(item.code)}
                >
                  <span className="block text-lg leading-tight">{item.native}</span>
                  <span className="text-xs font-bold text-brand-navy/50">{item.name}</span>
                </button>
              ))}
              {languages.length === 0 && <p className="col-span-2 text-sm font-semibold">Connecting to the tour…</p>}
            </div>
          </Card>
        ) : (
          <>
            <button type="button" className="text-left text-sm font-extrabold text-brand-blue" onClick={() => setLanguage("")}>
              Language: {selected?.native || language}. Change
            </button>
            {!listening ? (
              <Button type="button" size="lg" data-testid="guest-listen" onClick={() => void listen()}>
                Tap to listen
              </Button>
            ) : (
              <Button type="button" size="lg" variant="yellow" onClick={() => playerRef.current?.resume()}>
                {paused ? "Sound paused — tap to resume" : "Listening"}
              </Button>
            )}
            <Card>
              <p
                dir={selected?.dir || "ltr"}
                data-testid="guest-caption"
                className="min-h-24 text-2xl font-extrabold leading-snug text-brand-navy"
              >
                {caption || "Captions in your language appear here as the guide speaks."}
              </p>
            </Card>
            <p className="rounded-2xl bg-brand-yellow px-4 py-3 text-center text-sm font-extrabold text-brand-navy" data-testid="guest-disclosure">
              Translated by AI
            </p>
            <p className="text-sm font-semibold leading-relaxed text-brand-navy/80">
              {iosDevice
                ? "iPhone often pauses this page when the screen locks or you leave Safari. Keep the screen on, or wake the phone and tap Resume. A home-screen icon does not fix that."
                : "Android usually keeps the sound going with the screen off after you tap listen. If a notification steals the audio, come back and tap Resume."}
              {screenLock === false ? " This phone did not allow a screen wake lock." : ""}
            </p>
            <Card>
              <CardTitle>Saved stops</CardTitle>
              <p className="mt-2 text-sm font-bold" data-testid="guest-cache">
                {offline ? "No signal. " : ""}
                {saved.length} stop{saved.length === 1 ? "" : "s"} saved on this phone
                {stops.length ? ` · ${Math.min(saved.length, stops.length)} of ${stops.length} for this tour` : ""}.
              </p>
              <div className="mt-3 flex flex-col gap-2">
                {(saved.length ? saved : []).map((stop) => (
                  <Button key={stop.id} type="button" variant="outline" onClick={() => void playSaved(code, language, stop, playUrl, setCaption)}>
                    Play {stop.name} on this phone
                  </Button>
                ))}
                {saved.length === 0 && <p className="text-sm font-semibold text-brand-navy/60">Stops download when you join, if the guide has prepared them.</p>}
              </div>
            </Card>
            <Card>
              <CardTitle>Ask the guide</CardTitle>
              <button
                type="button"
                className={`hold mt-3 min-h-16 w-full rounded-2xl font-extrabold ${holding ? "bg-brand-red text-white" : "bg-brand-navy text-white"}`}
                data-testid="guest-hold"
                onPointerDown={beginQuestion}
                onPointerUp={endQuestion}
                onPointerCancel={endQuestion}
              >
                {holding ? "Release to send" : "Hold to talk"}
              </button>
              <form className="mt-3 flex gap-2" onSubmit={sendTyped}>
                <input
                  className="min-h-12 flex-1 rounded-2xl border-2 border-slate-200 px-3 font-semibold"
                  data-testid="guest-typed"
                  placeholder="Or type a question"
                  value={typed}
                  dir={selected?.dir || "ltr"}
                  onChange={(event) => setTyped(event.target.value)}
                />
                <Button type="submit" variant="navy">
                  Send
                </Button>
              </form>
              {asking && <p className="mt-2 text-sm font-bold text-brand-blue">{asking}</p>}
            </Card>
          </>
        )}

        <details className="rounded-3xl bg-white p-4 text-sm font-semibold leading-relaxed text-brand-navy/80 shadow-card">
          <summary className="cursor-pointer font-extrabold text-brand-navy">Privacy notice</summary>
          <p className="mt-2">
            The translation you hear is made by AI services chosen by Tourmania. Only the guide's speech is processed for the live translation.
            If you hold the question button, that short clip is translated into English for the guide and is not kept afterwards.
            Live audio is not stored unless the operator turns storage on. This notice is a placeholder for Tourmania's lawyer to replace.
            Contact info@tourmania.com.
          </p>
        </details>
        {error && <p className="rounded-2xl bg-brand-red px-4 py-3 text-sm font-extrabold text-white">{error}</p>}
        {savedCount > 0 && offline && (
          <p className="text-sm font-bold text-brand-navy">You can play the saved stops above without a signal.</p>
        )}
      </main>
      <Footer />
    </div>
  );
}

function speechLang(code: string): string {
  if (code === "zh") return "zh-CN";
  if (code === "pt") return "pt-BR";
  return code;
}

function storageKey(code: string, language: string): string {
  return `tm-stops-${code}-${language}`;
}

function readSaved(code: string, language: string): SavedStop[] {
  if (!language) return [];
  try {
    return JSON.parse(localStorage.getItem(storageKey(code, language)) || "[]") as SavedStop[];
  } catch {
    return [];
  }
}

async function prefetch(code: string, language: string, stops: Array<StopSummary | PublicStop>): Promise<SavedStop[]> {
  const saved: SavedStop[] = [];
  for (const stop of stops) {
    try {
      const captionResponse = await fetch(`/api/session/${code}/caption/${stop.id}/${language}`);
      if (!captionResponse.ok) continue;
      const captionBody = (await captionResponse.json()) as { caption: string };
      const audioUrl = `/api/session/${code}/audio/${stop.id}/${language}`;
      const audioResponse = await fetch(audioUrl);
      if (!audioResponse.ok) continue;
      const cache = await caches.open("tourmania-stops-v1");
      await cache.put(audioUrl, audioResponse.clone());
      saved.push({ id: stop.id, name: stop.name, caption: captionBody.caption });
    } catch {
      /* a missing language render should not block the others */
    }
  }
  localStorage.setItem(storageKey(code, language), JSON.stringify(saved));
  return saved;
}

async function playSaved(
  code: string,
  language: string,
  stop: SavedStop,
  playUrl: (url: string, utteranceId: string) => Promise<void>,
  setCaption: (caption: string) => void,
): Promise<void> {
  setCaption(stop.caption);
  await playUrl(`/api/session/${code}/audio/${stop.id}/${language}`, stop.id);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
