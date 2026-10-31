import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_LINE } from "../src/shared/demo";
import type { ServerMessage } from "../src/shared/protocol";
import { LanguageFanout } from "../src/server/fanout";
import { MockProvider } from "../src/server/providers/mock";
import type { LanguageStream, StreamHandlers, TranslationProvider } from "../src/server/providers/types";
import { pcmToWav } from "../src/server/wav";

test("one live stream per language, and audio stays inside that language", () => {
  const opens: { lang: string; writes: number; closed: boolean; handlers: StreamHandlers }[] = [];
  const provider: TranslationProvider = {
    id: "fake",
    label: "Fake stream",
    delivery: "per-language-stream",
    supports: () => ({ live: true, scripts: true }),
    openLanguageStream(lang, handlers): LanguageStream {
      const rec = { lang, writes: 0, closed: false, handlers };
      opens.push(rec);
      return {
        writePcm() {
          rec.writes += 1;
        },
        endUtterance() {},
        close() {
          rec.closed = true;
        },
      };
    },
    async transcribe() {
      return { text: "" };
    },
    async translate(text) {
      return { text };
    },
    async translateToEnglish(text) {
      return { text };
    },
    async synthesize() {
      return { bytes: pcmToWav(Buffer.alloc(320), 16000), mime: "audio/wav", sampleRate: 16000 };
    },
  };
  const inbox = new Map<string, ServerMessage[]>();
  const push = (id: string, message: ServerMessage) => {
    const list = inbox.get(id) ?? [];
    list.push(message);
    inbox.set(id, list);
  };
  const fanout = new LanguageFanout(provider, ["Side"], {
    toGuest: push,
    toGuide: (message) => push("guide", message),
    onUsage: () => undefined,
    onLatency: () => undefined,
  });
  for (const id of ["a", "b", "c"]) fanout.addGuest(id, "de");
  for (const id of ["d", "e"]) fanout.addGuest(id, "es");
  fanout.addGuest("f", "fr");
  assert.deepEqual(fanout.activeLanguages(), ["de", "es", "fr"]);
  assert.equal(opens.length, 3);
  fanout.pushPcm(Buffer.from([1, 2, 3, 4]), "u1");
  assert.deepEqual(opens.map((item) => item.writes), [1, 1, 1]);

  opens.find((item) => item.lang === "de")?.handlers.onAudio({
    bytes: pcmToWav(Buffer.alloc(320), 16000),
    mime: "audio/wav",
    sampleRate: 16000,
  });
  const heard = (id: string) => (inbox.get(id) ?? []).filter((message) => message.type === "audio");
  assert.equal(heard("a").length, 1);
  assert.equal(heard("b").length, 1);
  assert.equal(heard("c").length, 1);
  assert.equal(heard("d").length, 0);
  assert.equal(heard("f").length, 0);
  assert.equal((heard("a")[0] as { language: string }).language, "de");

  fanout.removeGuest("a");
  fanout.removeGuest("b");
  assert.equal(opens.find((item) => item.lang === "de")?.closed, false);
  fanout.removeGuest("c");
  assert.equal(opens.find((item) => item.lang === "de")?.closed, true);
  assert.deepEqual(fanout.activeLanguages(), ["es", "fr"]);
  fanout.setLanguage("f", "es");
  assert.equal(opens.find((item) => item.lang === "fr")?.closed, true);
  assert.deepEqual(fanout.activeLanguages(), ["es"]);
  fanout.close();
});

test("shared speech-to-text runs once and translation runs once per language", async () => {
  const provider = new MockProvider();
  let translations = 0;
  let transcripts = 0;
  const translate = provider.translate.bind(provider);
  const transcribe = provider.transcribe.bind(provider);
  provider.translate = async (...args) => {
    translations += 1;
    return translate(...args);
  };
  provider.transcribe = async (...args) => {
    transcripts += 1;
    return transcribe(...args);
  };
  const inbox = new Map<string, ServerMessage[]>();
  const fanout = new LanguageFanout(provider, ["Hagia Sophia", "Istanbul"], {
    toGuest: (id, message) => {
      const list = inbox.get(id) ?? [];
      list.push(message);
      inbox.set(id, list);
    },
    toGuide: (message) => {
      const list = inbox.get("guide") ?? [];
      list.push(message);
      inbox.set("guide", list);
    },
    onUsage: () => undefined,
    onLatency: () => undefined,
  });
  fanout.addGuest("g1", "de");
  fanout.addGuest("g2", "de");
  fanout.addGuest("g3", "es");
  fanout.addGuest("g4", "ja");
  fanout.addGuest("g5", "ar");
  fanout.addGuest("g6", "ar");
  assert.deepEqual(fanout.activeLanguages(), ["ar", "de", "es", "ja"]);
  await fanout.endUtterance({ utteranceId: "demo-1", hint: DEMO_LINE, speechEndedAt: Date.now() });
  assert.equal(transcripts, 0, "a supplied transcript should skip speech-to-text");
  assert.equal(translations, 4);
  const german = inbox.get("g1")?.find((message) => message.type === "caption");
  const germanToo = inbox.get("g2")?.find((message) => message.type === "caption");
  const spanish = inbox.get("g3")?.find((message) => message.type === "caption");
  const arabic = inbox.get("g6")?.find((message) => message.type === "caption");
  assert.equal(german?.type === "caption" && german.text, germanToo?.type === "caption" ? germanToo.text : "");
  assert.match(german?.type === "caption" ? german.text : "", /Willkommen/);
  assert.match(german?.type === "caption" ? german.text : "", /Hagia Sophia/);
  assert.match(spanish?.type === "caption" ? spanish.text : "", /Bienvenidos/);
  assert.match(arabic?.type === "caption" ? arabic.text : "", /Hagia Sophia/);
  assert.equal(inbox.get("g3")?.some((message) => message.type === "audio" && message.language === "de"), false);
  const guide = inbox.get("guide")?.find((message) => message.type === "caption");
  assert.match(guide?.type === "caption" ? guide.text : "", /Hagia Sophia/);
  fanout.close();
});
