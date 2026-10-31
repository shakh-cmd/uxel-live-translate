import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import QRCode from "qrcode";
import { WebSocket, WebSocketServer } from "ws";
import http from "node:http";
import type { ClientMessage } from "../shared/protocol";
import { pinFrom, pinMatches } from "./auth";
import { loadConfig, type Config } from "./config";
import { log } from "./log";
import { metricsToCsv } from "./metrics";
import { createProvider, type TranslationProvider } from "./providers";
import { SessionStore } from "./session";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export type AppOptions = {
  config?: Config;
  provider?: TranslationProvider;
};

export async function createApp(options: AppOptions = {}) {
  const config = options.config ?? loadConfig();
  const provider = options.provider ?? createProvider(config);
  const store = new SessionStore(config, provider);
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      product: "Tourmania Live Translate",
      provider: provider.id,
      providerLabel: provider.label,
      maxGuests: config.maxGuests,
      storeAudio: config.storeAudio,
    });
  });

  app.post("/api/guide/session", (req, res) => {
    if (!authorized(req, config)) return res.status(401).json({ error: "Wrong PIN." });
    const session = store.create(publicBase(req, config));
    res.json({ code: session.code, joinUrl: session.joinUrl(), maxGuests: config.maxGuests });
  });

  app.post("/api/guide/session/:code/end", (req, res) => {
    if (!authorized(req, config)) return res.status(401).json({ error: "Wrong PIN." });
    const session = store.get(req.params.code);
    if (!session) return res.status(404).json({ error: "No tour with that code." });
    store.end(session.code);
    res.json({ ok: true });
  });

  app.post("/api/guide/session/:code/stops", async (req, res) => {
    if (!authorized(req, config)) return res.status(401).json({ error: "Wrong PIN." });
    const session = store.get(req.params.code);
    if (!session) return res.status(404).json({ error: "No tour with that code." });
    const name = String(req.body?.name || "").trim();
    const script = String(req.body?.script || "").trim();
    if (!name || !script) return res.status(400).json({ error: "A stop needs a name and an English script." });
    if (name.length > 80 || script.length > 2000) {
      return res.status(400).json({ error: "Keep the name under 80 characters and the script under 2000." });
    }
    const stop = await session.renderStop(name, script);
    res.json({ stop });
  });

  app.get("/api/guide/session/:code/export.json", (req, res) => {
    if (!authorized(req, config)) return res.status(401).json({ error: "Wrong PIN." });
    const session = store.get(req.params.code);
    if (!session) return res.status(404).json({ error: "No tour with that code." });
    res.json(session.metrics.snapshot());
  });

  app.get("/api/guide/session/:code/export.csv", (req, res) => {
    if (!authorized(req, config)) return res.status(401).json({ error: "Wrong PIN." });
    const session = store.get(req.params.code);
    if (!session) return res.status(404).json({ error: "No tour with that code." });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="tourmania-${session.code}.csv"`);
    res.send(metricsToCsv(session.metrics.snapshot()));
  });

  app.get("/api/session/:code", (req, res) => {
    const session = store.get(req.params.code);
    if (!session) return res.status(404).json({ error: "This tour code is not active." });
    res.json({
      code: session.code,
      joinUrl: session.joinUrl(),
      broadcasting: session.broadcasting,
      stops: session.publicStops(),
      maxGuests: config.maxGuests,
    });
  });

  app.get("/api/session/:code/stops", (req, res) => {
    const session = store.get(req.params.code);
    if (!session) return res.status(404).json({ error: "This tour code is not active." });
    res.json({ stops: session.publicStops() });
  });

  app.get("/api/session/:code/audio/:stopId/:lang", (req, res) => {
    const session = store.get(req.params.code);
    const render = session?.audioFor(req.params.stopId, req.params.lang);
    if (!render?.ok) return res.status(404).json({ error: "That stop is not ready in this language." });
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(render.audio);
  });

  app.get("/api/session/:code/caption/:stopId/:lang", (req, res) => {
    const session = store.get(req.params.code);
    const caption = session?.captionFor(req.params.stopId, req.params.lang);
    if (!caption) return res.status(404).json({ error: "No caption for that stop." });
    res.json({ caption });
  });

  app.get("/api/session/:code/qr.png", async (req, res) => {
    const session = store.get(req.params.code);
    if (!session) return res.status(404).end();
    const png = await QRCode.toBuffer(session.joinUrl(), {
      width: 560,
      margin: 2,
      color: { dark: "#0B2D6B", light: "#FFFFFF" },
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(png);
  });

  app.get("/manifest.webmanifest", (req, res) => {
    const start = typeof req.query.start === "string" && req.query.start.startsWith("/") ? req.query.start : "/";
    res.type("application/manifest+json").json({
      name: "Tourmania Live Translate",
      short_name: "Tourmania",
      description: "Live tour translation. Translated by AI.",
      start_url: start,
      scope: "/",
      display: "standalone",
      background_color: "#0B2D6B",
      theme_color: "#0B2D6B",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ],
    });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 8 * 1024 * 1024 });
  wss.on("connection", (ws, req) => bindSocket(ws, req, store, config));

  if (config.dev) {
    const { createServer: createVite } = await import("vite");
    const vite = await createVite({
      root: path.join(root, "src/client"),
      appType: "custom",
      server: { middlewareMode: true, hmr: { port: config.port + 10000 } },
    });
    // Serve the app shell before Vite. Otherwise /guide is treated as guide.tsx.
    app.use(async (req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/@") || path.extname(req.path)) return next();
      try {
        let html = await readFile(path.join(root, "src/client/index.html"), "utf8");
        html = await vite.transformIndexHtml(req.originalUrl, html);
        res.status(200).setHeader("Content-Type", "text/html").end(html);
      } catch (error) {
        next(error);
      }
    });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(root, "dist/client");
    app.use(express.static(dist, { index: false }));
    app.get("*", (req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/ws")) return next();
      res.sendFile(path.join(dist, "index.html"), (error) => {
        if (error) next();
      });
    });
  }

  return { app, server, store, config, provider };
}

function authorized(req: Request, config: Config): boolean {
  return pinMatches(pinFrom(req.header("x-guide-pin")), config.guidePin);
}

function publicBase(req: Request, config: Config): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const proto = forwardedProto || req.protocol;
  const host = forwardedHost || req.get("host");
  return `${proto}://${host}`;
}

function bindSocket(ws: WebSocket, req: http.IncomingMessage, store: SessionStore, config: Config): void {
  const url = new URL(req.url || "", "http://localhost");
  const role = url.searchParams.get("role");
  const code = url.searchParams.get("code") || "";
  const session = store.get(code);
  if (!session || (role !== "guide" && role !== "guest")) {
    ws.close(4004, "no session");
    return;
  }
  let authed = false;
  const timer = setTimeout(() => {
    if (!authed) ws.close(4001, "hello timeout");
  }, 8000);
  ws.on("message", (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    if (!authed) {
      if (message.type !== "hello") {
        ws.close(4001, "hello first");
        return;
      }
      if (role === "guide") {
        if (message.role !== "guide" || !pinMatches(message.pin, config.guidePin)) {
          ws.close(4001, "bad pin");
          return;
        }
        authed = true;
        clearTimeout(timer);
        session.attachGuide(ws, message.clientId || "guide");
        return;
      }
      if (message.role !== "guest") {
        ws.close(4003, "role");
        return;
      }
      authed = true;
      clearTimeout(timer);
      const accepted = session.attachGuest(ws, message.clientId || `guest-${Date.now()}`, message.language);
      if (!accepted) {
        sendJson(ws, { type: "error", message: `This tour is full (${config.maxGuests} phones).` });
        ws.close(4003, "full");
      }
      return;
    }
    void session.onMessage(ws, message).catch((error) => {
      const text = error instanceof Error ? error.message : String(error);
      log("message-error", { message: text });
      sendJson(ws, { type: "error", message: text });
    });
  });
  // Browsers never send pings. Ping from here so proxies keep idle guest sockets open
  // and dead ones are noticed.
  let alive = true;
  ws.on("pong", () => {
    alive = true;
  });
  const pinger = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      /* closed */
    }
  }, 25_000);
  pinger.unref?.();
  ws.on("close", (closeCode) => {
    clearInterval(pinger);
    clearTimeout(timer);
    if (authed) session.detach(ws, closeCode);
  });
}

function sendJson(ws: WebSocket, message: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
