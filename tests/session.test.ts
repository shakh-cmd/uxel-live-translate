import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import WebSocket from "ws";
import { DEMO_LINE, SAMPLE_STOP } from "../src/shared/demo";
import type { ServerMessage } from "../src/shared/protocol";
import { createApp } from "../src/server/app";
import { loadConfig } from "../src/server/config";

test("session pin, guest cap, and language fan-out over the websocket", async () => {
  const config = loadConfig({
    TRANSLATION_PROVIDER: "mock",
    GUIDE_PIN: "2468",
    NODE_ENV: "production",
    STORE_AUDIO: "false",
    MAX_GUESTS: "2",
    PORT: "0",
  });
  const { server } = await createApp({ config });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const sockets: WebSocket[] = [];
  try {
    const denied = await fetch(`${base}/api/guide/session`, { method: "POST", headers: { "x-guide-pin": "0000" } });
    assert.equal(denied.status, 401);
    const created = await fetch(`${base}/api/guide/session`, { method: "POST", headers: { "x-guide-pin": "2468" } });
    assert.equal(created.status, 200);
    const body = (await created.json()) as { code: string; joinUrl: string };
    assert.match(body.joinUrl, new RegExp(`/g/${body.code}$`));

    const guide = await openSocket(port, "guide", body.code, sockets);
    guide.ws.send(JSON.stringify({ type: "hello", role: "guide", clientId: "guide-1", pin: "9999" }));
    await once(guide.ws, "close");
    assert.equal(guide.ws.closeReason || "bad pin", "bad pin");

    const guideOk = await openSocket(port, "guide", body.code, sockets);
    guideOk.ws.send(JSON.stringify({ type: "hello", role: "guide", clientId: "guide-1", pin: "2468" }));
    await waitFor(guideOk.messages, (message) => message.type === "welcome");
    guideOk.ws.send(JSON.stringify({ type: "broadcast", action: "start" }));

    const german = await openSocket(port, "guest", body.code, sockets);
    german.ws.send(JSON.stringify({ type: "hello", role: "guest", clientId: "guest-de", language: "de" }));
    const spanish = await openSocket(port, "guest", body.code, sockets);
    spanish.ws.send(JSON.stringify({ type: "hello", role: "guest", clientId: "guest-es", language: "es" }));
    await waitFor(german.messages, (message) => message.type === "welcome");
    await waitFor(spanish.messages, (message) => message.type === "welcome");

    const extra = await openSocket(port, "guest", body.code, sockets);
    extra.ws.send(JSON.stringify({ type: "hello", role: "guest", clientId: "guest-fr", language: "fr" }));
    const [extraCode, extraReason] = await once(extra.ws, "close");
    assert.equal(extraCode, 4003);
    assert.equal(String(extraReason), "full");

    guideOk.ws.send(JSON.stringify({ type: "demo", text: DEMO_LINE }));
    const germanCaption = await waitFor(
      german.messages,
      (message) => message.type === "caption" && message.language === "de" && message.text.includes("Willkommen"),
    );
    const spanishCaption = await waitFor(
      spanish.messages,
      (message) => message.type === "caption" && message.language === "es",
    );
    assert.equal(germanCaption.type === "caption" && germanCaption.text.includes("Hagia Sophia"), true);
    assert.match(spanishCaption.type === "caption" ? spanishCaption.text : "", /Bienvenidos/);
    assert.equal(
      spanish.messages.some((message) => message.type === "audio" && message.language === "de"),
      false,
    );
    await waitFor(german.messages, (message) => message.type === "audio" && message.language === "de");

    const pipelines = guideOk.messages.filter((message) => message.type === "pipelines").at(-1);
    assert.deepEqual(pipelines && pipelines.type === "pipelines" ? [...pipelines.languages].sort() : [], ["de", "es"]);

    const stopResponse = await fetch(`${base}/api/guide/session/${body.code}/stops`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-guide-pin": "2468" },
      body: JSON.stringify(SAMPLE_STOP),
    });
    assert.equal(stopResponse.status, 200);
    const stopBody = (await stopResponse.json()) as { stop: { languages: { code: string; ok: boolean }[] } };
    assert.equal(stopBody.stop.languages.find((lang) => lang.code === "de")?.ok, true);
    assert.equal(stopBody.stop.languages.find((lang) => lang.code === "ar")?.ok, true);

    const exported = await fetch(`${base}/api/guide/session/${body.code}/export.json`, { headers: { "x-guide-pin": "2468" } });
    const snapshot = (await exported.json()) as { provider: string; latency: unknown[]; statusLog: unknown[] };
    assert.equal(snapshot.provider, "mock");
    assert.ok(snapshot.latency.length >= 2);
    const csvDenied = await fetch(`${base}/api/guide/session/${body.code}/export.csv`);
    assert.equal(csvDenied.status, 401);
  } finally {
    for (const socket of sockets) socket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function openSocket(port: number, role: string, code: string, bucket: WebSocket[]): Promise<{ ws: WebSocket; messages: ServerMessage[] }> {
  const messages: ServerMessage[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}&code=${code}`);
  bucket.push(ws);
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, messages }));
    ws.once("error", reject);
  });
}

async function waitFor(messages: ServerMessage[], predicate: (message: ServerMessage) => boolean, timeoutMs = 20_000): Promise<ServerMessage> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for a message; saw ${messages.map((message) => message.type).join(",")}`);
}
