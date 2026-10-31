import assert from "node:assert/strict";
import test from "node:test";
import type { ServerMessage } from "../src/shared/protocol";
import { MAX_LIVE_BACKLOG_SEC, planChunk } from "../src/client/player";
import { loadConfig } from "../src/server/config";
import { LanguageFanout } from "../src/server/fanout";
import { MockProvider } from "../src/server/providers/mock";
import { shouldPadSilence } from "../src/server/providers/gemini";
import { SessionStore } from "../src/server/session";

test("text model default is one Google still serves", () => {
  const config = loadConfig({ NODE_ENV: "production" });
  assert.equal(config.geminiTextModel, "gemini-3.5-flash-lite");
  assert.equal(loadConfig({ GEMINI_TEXT_MODEL: "gemini-3.8-flash" }).geminiTextModel, "gemini-3.8-flash");
  assert.equal(config.geminiSilencePadMs, 4000);
});

test("silence is streamed to Gemini after speech so the translation can finish", () => {
  const base = { lastRealAt: 10_000, lastVoiceOutAt: 0, minMs: 4000, maxMs: 30_000 };
  assert.equal(shouldPadSilence({ ...base, now: 10_050 }), false, "real audio still flowing");
  assert.equal(shouldPadSilence({ ...base, now: 10_500 }), true, "short pause is filled");
  assert.equal(shouldPadSilence({ ...base, now: 13_900 }), true);
  assert.equal(shouldPadSilence({ ...base, now: 15_000 }), false, "stops once Gemini is quiet");
  assert.equal(shouldPadSilence({ ...base, now: 15_000, lastVoiceOutAt: 14_500 }), true, "continues while Gemini talks");
  assert.equal(shouldPadSilence({ ...base, now: 41_000, lastVoiceOutAt: 40_900 }), false, "hard cap");
  assert.equal(shouldPadSilence({ ...base, lastRealAt: 0, now: 5000 }), false, "nothing to pad before speech");
});

test("live audio plays back to back and never queues more than a few seconds", () => {
  // Back to back: the next chunk starts exactly where the previous ended.
  const first = planChunk(100, 0);
  assert.equal(first.skip, false);
  const second = planChunk(100.01, first.start + 0.25);
  assert.equal(second.start, first.start + 0.25);
  // A late chunk starts right away instead of in the past.
  assert.ok(planChunk(200, 150).start > 200);
  // Too far behind: drop the backlog and jump to live.
  const behind = planChunk(100, 100 + MAX_LIVE_BACKLOG_SEC + 1);
  assert.equal(behind.skip, true);
  assert.ok(behind.start - 100 < 0.2);
});

test("a failed guest question reaches the guide instead of vanishing", async () => {
  const provider = new MockProvider();
  provider.translateToEnglish = async () => {
    throw new Error("Gemini text 404");
  };
  const guide: ServerMessage[] = [];
  const guest: ServerMessage[] = [];
  const fanout = new LanguageFanout(provider, [], {
    toGuest: (_id, message) => guest.push(message),
    toGuide: (message) => guide.push(message),
    onUsage: () => undefined,
    onLatency: () => undefined,
  });
  await fanout.handleQuestion("g1", "fr", Buffer.alloc(0), "Quand ferme le bazar ?");
  assert.ok(guide.some((m) => m.type === "error" && m.message.includes("question")));
  assert.ok(guest.some((m) => m.type === "error"));
  assert.ok(guide.some((m) => m.type === "activity" && m.asking.includes("g1")), "guide sees who is asking");
  fanout.close();
});

test("a guest question arrives at the guide with English audio", async () => {
  const guide: ServerMessage[] = [];
  const fanout = new LanguageFanout(new MockProvider(), [], {
    toGuest: () => undefined,
    toGuide: (message) => guide.push(message),
    onUsage: () => undefined,
    onLatency: () => undefined,
  });
  await fanout.handleQuestion("g1", "fr", Buffer.alloc(0), "Quand ferme le bazar ?");
  const question = guide.find((m) => m.type === "question");
  assert.ok(question && question.type === "question");
  assert.ok(question.english.length > 0);
  assert.ok((question.audio?.length ?? 0) > 100);
  fanout.close();
});

test("forgotten tours are ended instead of logging forever", () => {
  const config = loadConfig({ NODE_ENV: "production", IDLE_SESSION_MINUTES: "30" });
  const store = new SessionStore(config, new MockProvider());
  const session = store.create("http://x");
  assert.deepEqual(store.sweep(Date.now() + 10 * 60_000), []);
  assert.deepEqual(store.sweep(Date.now() + 31 * 60_000), [session.code]);
  assert.equal(store.get(session.code), undefined);
});
