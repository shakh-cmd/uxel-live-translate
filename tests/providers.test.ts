import assert from "node:assert/strict";
import test from "node:test";
import { LANGUAGES } from "../src/shared/languages";
import { loadConfig } from "../src/server/config";
import { createProvider, languageOffers } from "../src/server/providers";
import {
  buildGeminiAudioMessage,
  buildGeminiAudioStreamEnd,
  buildGeminiSetup,
  buildGeminiTextBody,
  geminiGenerateUrl,
} from "../src/server/providers/gemini";
import { geminiLiveUsd, openaiSttUsd, openaiTtsUsd } from "../src/server/rates";
import {
  buildOpenAiSpeechBody,
  buildOpenAiTranslateBody,
  openAiTranscriptionFields,
} from "../src/server/providers/openai";

test("provider factory picks mock without keys and refuses live providers with no key", () => {
  const mock = createProvider(loadConfig({ TRANSLATION_PROVIDER: "mock", NODE_ENV: "production" }));
  assert.equal(mock.id, "mock");
  assert.equal(mock.delivery, "shared-stt");
  assert.throws(() => createProvider(loadConfig({ TRANSLATION_PROVIDER: "gemini", GEMINI_API_KEY: "", NODE_ENV: "production" })), /GEMINI_API_KEY/);
  assert.throws(() => createProvider(loadConfig({ TRANSLATION_PROVIDER: "openai", OPENAI_API_KEY: "", NODE_ENV: "production" })), /OPENAI_API_KEY/);
  const gemini = createProvider(loadConfig({ TRANSLATION_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", NODE_ENV: "production" }));
  assert.equal(gemini.delivery, "per-language-stream");
  const openai = createProvider(loadConfig({ TRANSLATION_PROVIDER: "openai", OPENAI_API_KEY: "test-key", NODE_ENV: "production" }));
  assert.equal(openai.delivery, "shared-stt");
});

test("every pilot language is marked on each provider, with the real model codes", () => {
  const mock = createProvider(loadConfig({ TRANSLATION_PROVIDER: "mock", NODE_ENV: "production" }));
  const gemini = createProvider(loadConfig({ TRANSLATION_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", NODE_ENV: "production" }));
  const openai = createProvider(loadConfig({ TRANSLATION_PROVIDER: "openai", OPENAI_API_KEY: "test-key", NODE_ENV: "production" }));
  for (const provider of [mock, gemini, openai]) {
    const offers = languageOffers(provider);
    assert.deepEqual(offers.map((item) => item.code), LANGUAGES.map((item) => item.code));
    assert.equal(offers.every((item) => item.live && item.scripts), true);
  }
  assert.match(languageOffers(gemini)[0].note || "", /Live Translate/);
  assert.match(languageOffers(openai)[0].note || "", /gpt-realtime-translate/);
  assert.match(languageOffers(openai)[0].note || "", /Malay/);
});

test("Gemini Live Translate setup matches the published websocket shape", () => {
  const setup = buildGeminiSetup({
    model: "gemini-3.5-live-translate-preview",
    targetLanguageCode: "pl",
    glossary: ["Side", "Hagia Sophia"],
  });
  assert.equal(setup.setup.model, "models/gemini-3.5-live-translate-preview");
  assert.deepEqual(setup.setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.equal(setup.setup.generationConfig.translationConfig.targetLanguageCode, "pl");
  assert.equal(setup.setup.generationConfig.translationConfig.echoTargetLanguage, false);
  assert.deepEqual(setup.setup.inputAudioTranscription, {});
  assert.deepEqual(setup.setup.outputAudioTranscription, {});
  assert.equal("inputAudioTranscription" in setup.setup.generationConfig, false);
  assert.match(setup.setup.systemInstruction.parts[0].text, /Hagia Sophia/);
  assert.deepEqual(buildGeminiAudioMessage("AAAA"), {
    realtimeInput: { audio: { data: "AAAA", mimeType: "audio/pcm;rate=16000" } },
  });
  assert.deepEqual(buildGeminiAudioStreamEnd(), { realtimeInput: { audioStreamEnd: true } });
  assert.equal(geminiGenerateUrl("gemini-2.5-flash"), "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  assert.equal(buildGeminiTextBody("Hello").contents[0].parts[0].text, "Hello");
});

test("OpenAI modular calls use one key's three documented endpoints", () => {
  const speech = buildOpenAiSpeechBody({ model: "tts-1", input: "Guten Tag", voice: "nova" });
  assert.equal(speech.model, "tts-1");
  assert.equal(speech.response_format, "wav");
  assert.equal(speech.voice, "nova");
  const chat = buildOpenAiTranslateBody({ model: "gpt-4.1-mini", system: "translate", user: "Hello" });
  assert.equal(chat.model, "gpt-4.1-mini");
  assert.equal(chat.messages[1].content, "Hello");
  const stt = openAiTranscriptionFields({ model: "gpt-transcribe", language: "en", prompt: "Side, Aspendos" });
  assert.equal(stt.model, "gpt-transcribe");
  assert.equal(stt.response_format, "json");
  assert.match(stt.prompt, /Aspendos/);
});

test("cost estimate uses the published per-minute rates", () => {
  const minute = geminiLiveUsd(60, 30);
  assert.ok(Math.abs(minute - (0.00525 + 0.01575)) < 0.0001);
  assert.ok(Math.abs(openaiSttUsd(60) - 0.0045) < 1e-9);
  assert.ok(Math.abs(openaiTtsUsd("tts-1", 1_000_000).usd - 15) < 1e-9);
});
