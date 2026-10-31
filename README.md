# Tourmania Live Translate

The guide speaks English. Each guest hears that tour in their own language, on their own phone, through their own earphones. Nothing to install for guests: they scan a QR code.

This is the pilot. It is built for one guide and up to 6 guests. The same guest page can later be served by a computer in the guide's bag when there is no mobile signal. That local server is not part of this pilot.

Contact: info@tourmania.com

## Run it on your computer

You need Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open http://127.0.0.1:4317/guide

The pilot PIN is **2468** until you change it. On the guide page, enter the PIN and tap **Start a tour**. A QR code appears. Open that link on another phone, or on the same computer, pick a language, and tap **Tap to listen**. On the guide page, tap **Start broadcast**, then **Send demo line**. The other phone should show the line in the language you picked, and play it.

`npm test` checks that one translation is shared by every guest of the same language, and that place names such as Side and Hagia Sophia are not translated.

## What you need before a real tour

| | Mock (practice) | Gemini (live voice) | OpenAI (sentence by sentence) |
|---|---|---|---|
| Key | none | `GEMINI_API_KEY` | `OPENAI_API_KEY` |
| Where | — | [Google AI Studio](https://aistudio.google.com/apikey) | [OpenAI API keys](https://platform.openai.com/api-keys) |
| Set | `TRANSLATION_PROVIDER=mock` | `TRANSLATION_PROVIDER=gemini` | `TRANSLATION_PROVIDER=openai` |

Copy `.env.example` to `.env` and fill in the PIN and one key.

Use a **paid** Gemini key. Google's free tier uses the audio to improve their models. A paid key does not.

Change `GUIDE_PIN` before any real group. The number 2468 is only for practice.

The guide's browser will not turn the microphone on unless the page is **https** (a lock in the address bar) or `localhost`. A plain `http://192.168.x.x` address is not enough for the browser. The Android guide app can use the microphone on a local http address. Guests do not need a microphone for listening.

Audio is not saved to disk. Pre-translated stop audio stays in memory until the guide ends the tour. Set `STORE_AUDIO=true` only if you have decided to keep recordings.

## Languages

The pilot offers German, Spanish, French, Italian, Russian, Arabic, Turkish, Polish, Malay, Japanese, Chinese, and Portuguese.

| Provider | Those 12 languages | How it speaks |
|---|---|---|
| Mock | all 12 | A built-in phrasebook, then a local voice (`espeak-ng`). No bill. |
| Gemini 3.5 Live Translate | all 12. Chinese is `zh-Hans`, Portuguese is `pt-BR`. | Live speech to speech. One session per language that has a guest. |
| OpenAI modular | all 12. Whisper's language list includes Malay, Arabic, Turkish, Polish, Japanese, Chinese, and Portuguese. | English speech to text (`gpt-transcribe`), then translation (`gpt-4.1-mini`), then speech (`tts-1`). |

OpenAI's other product, `gpt-realtime-translate`, does **not** speak Arabic, Turkish, Polish, or Malay. This app does not use it.

Checked against the provider docs on 31 Oct 2026:

- https://ai.google.dev/gemini-api/docs/live-api/live-translate
- https://ai.google.dev/gemini-api/docs/pricing
- https://developers.openai.com/api/docs/guides/speech-to-text
- https://developers.openai.com/api/docs/guides/text-to-speech
- https://developers.openai.com/api/docs/pricing

`tts-1` and `gpt-4o-mini-tts` are scheduled to shut down on 6 January 2027. `gpt-4.1-mini` is scheduled to shut down on 14 January 2027. The model names are in `.env.example` so they can be changed without rewriting the app.

## What was actually tried here

- **Mock provider:** tried end to end. Automated tests cover fan-out and the provider switch. A headless Chrome run used one guide page and guest pages in German, Spanish, Arabic, and Japanese. Captions arrived in those languages, with Hagia Sophia and Istanbul left as written. Screenshots are in the run artifacts.
- **Gemini Live Translate:** the websocket setup matches the current Live Translate guide (model `gemini-3.5-live-translate-preview`, 16 kHz PCM in, 24 kHz PCM out, `translationConfig.targetLanguageCode`). **Not tried with a real key.** No `GEMINI_API_KEY` was available.
- **OpenAI modular path:** the three HTTP calls match the current docs (file transcription, chat completions, speech as wav). **Not tried with a real key.** No `OPENAI_API_KEY` was available.

Live Translate does not accept typed text. Scripted stops are translated with `gemini-3.5-flash-lite` (set `GEMINI_TEXT_MODEL` to change it; `gemini-2.5-flash` now returns 404 for new keys) when Gemini is selected, and the spoken file for that stop is made locally with `espeak-ng`. The live voice during the tour still comes from Gemini.

## Place names

These stay as written: Side, Aspendos, Kaymaklı, Derinkuyu, Hagia Sophia, Basilica Cistern, Istanbul, Cappadocia, Göreme, Justinian. "Side" is only protected when it has a capital S, so the ordinary English word "side" can still be translated.

On the text path, each name is masked before translation and put back afterwards. On the Gemini live voice path, the session is also told not to translate them. The spoken audio from Gemini cannot be edited after the fact if the model still changes a name. Check a few names on a practice tour.

## Dead zones

Basilica Cistern, underground cities, and caves often have no signal.

1. On the guide page, name the stop and paste the English you would say there.
2. The server prepares every language before you go in.
3. Guest phones download those clips when they join. The guest page says how many are saved.
4. Tap the stop on the guide page and every connected phone plays its language.
5. If a phone has already lost signal, the guest can tap **Play on this phone**. That uses the saved clip. It does not need the network.

Live speech cannot be translated with no link at all. Brief the group before you walk in, and use the saved stops for the narration.

## Phones locking and leaving the page

Guests should tap **Tap to listen** once. That is required by the phone. After that:

- **Android Chrome** usually keeps playing with the screen off, after that tap. A notification or another app can still steal the sound. The guest comes back and taps **Resume**.
- **iPhone Safari** often pauses the page when the screen locks, or when the guest switches apps. Keeping the screen on, dimmed, is the reliable option. Adding the page to the home screen does not fix this. A native guest app would. This pilot does not include one.
- The guide's **browser** has the same limit. The **Android guide app** is the one that keeps the microphone on with the screen off. See below.

There is no supported way to force an iPhone to keep a website talking after the screen locks. Do not rely on it underground or in a pocket.

## Lag

The guide page shows **Connected**, **Lagging**, or **Offline**.

- Connected: the socket is up, the last sentence was not slow, and the network round trip is under 800 ms.
- Lagging: the last sentence took more than 3 seconds from the end of the English to the translated audio, or the round trip is over 800 ms.
- Offline: the guide's link is down.

The guide page logs that status every 10 seconds. Export CSV or JSON from the guide page. The file has the latency samples, dropped connections, and a cost estimate. The estimate uses the published per-minute prices. A long Gemini session can cost more than that estimate, because Google re-bills earlier audio as the conversation grows. The CSV is not an invoice.

Mock latency is only the time to build a local voice. It is not a forecast for Gemini or OpenAI.

## Guide Android app

Guests stay in the browser, including iPhone guests.

The guide app is a small Kotlin app, not a web page inside a shell. On a Samsung Galaxy S23 Ultra (Android 14), Chrome drops the microphone when the screen locks. A foreground service of type `microphone` is the supported way to keep recording. The service owns the microphone, the websocket, a partial wake lock, and the status notification (Connected / Lagging / Offline). It reconnects if the network blips. USB-C and Bluetooth microphones are listed from Android's audio devices and can be chosen while the tour is live.

Build a debug APK (the debug key is created by Android Studio / Gradle; it is enough to install on your own phones):

```bash
cd android
export ANDROID_HOME="$HOME/android-sdk"   # or the SDK path from Android Studio
./gradlew assembleDebug
```

The file is `android/app/build/outputs/apk/debug/app-debug.apk`.

Install on the Samsung:

1. Copy the APK onto the phone (USB, or mail it to yourself).
2. Settings → Security and privacy → Install unknown apps. Allow the app you used to open the file (Files or Chrome).
3. Tap the APK and install.
4. Open **Tourmania Live Translate**. Allow the microphone, notifications, and nearby Bluetooth devices.
5. Server URL: the https address of this service. PIN: the same `GUIDE_PIN`.
6. Tap **Open a tour**. Guests scan the QR code with their normal browser. They do not install the app.
7. Tap **Start broadcast**. A notification stays. You can lock the phone or switch apps. Plug in a USB-C mic, or connect a Bluetooth mic, and pick it under Microphone.

The notification has **Stop**.

## Put it on the internet

The phone microphone in Chrome needs HTTPS. Render, Fly.io, and Railway all provide that for a web service that speaks WebSockets.

```bash
docker build -t tourmania-live-translate .
docker run --rm -p 4317:4317 -e GUIDE_PIN=your-pin -e TRANSLATION_PROVIDER=mock tourmania-live-translate
```

**Render:** use the included `render.yaml`, or create a Web Service from this repo with the Docker runtime. Add `GUIDE_PIN` and, when you are ready, `TRANSLATION_PROVIDER` and the API key. Render sets `PORT` itself. Health check: `/api/health`.

**Fly.io:** `fly launch --no-deploy` then `fly secrets set GUIDE_PIN=...` and `fly deploy`. `fly.toml` keeps one machine running. Do not let the host sleep the machine in the middle of a tour, or every guest goes quiet.

**Railway:** New project → Deploy from GitHub → Dockerfile. Add the same variables. Railway gives you an https address. Use that address on the guide phone and in the Android app.

Set `PUBLIC_BASE_URL` to that https address if the QR code shows an internal host instead of the public one.

After it is deployed, open `https://your-address/guide` on the guide phone. The lock icon must be there before you trust the browser microphone. Or use the Android app pointed at the same address.

## Try it with 6 phones

1. Deploy with HTTPS, or run `npm run dev` on a laptop and use `localhost` for a single-computer practice.
2. On the guide phone, open `/guide` (or the Android app). PIN, then **Start a tour**.
3. Six guests scan the QR code. Each picks a different language and taps **Tap to listen**. They use their own earphones.
4. The guide page should list 6 guests and only as many pipelines as languages (two German guests are one pipeline).
5. The guide taps **Start broadcast** and speaks a short sentence, or taps **Send demo line**.
6. Each guest hears their language and sees captions. The yellow line says **Translated by AI**.
7. Add the Basilica Cistern stop. Each guest page should say the stop is saved. Tap the stop. Then turn on airplane mode on one guest phone and tap **Play on this phone**.
8. Export the CSV from the guide page.

The pilot refuses a 7th guest.

## Pilot checklist

- [ ] PIN is not 2468.
- [ ] Provider is `gemini` or `openai`, and the key is the paid one.
- [ ] Guide page shows Connected on the venue wifi or the phone hotspot.
- [ ] At least two languages play on two phones, earphones in.
- [ ] A place name (Hagia Sophia, Side, Derinkuyu) is spoken and still sounds like the name.
- [ ] One scripted stop is prepared, saved on the phones, and plays with the network off.
- [ ] iPhone guest has been told to keep the screen on.
- [ ] Guide Android app keeps the notification and the microphone with the screen locked.
- [ ] CSV export opens and has timestamps.
- [ ] Guests can read the privacy note. It is a placeholder for the lawyer.

## Layout, for later

```
Guide phone  --websocket-->  this server  --one pipeline per language-->  guest phones
```

The guest page does not care whether that server is in the cloud or on a computer in the bag. The QR code is the address. A later offline box can serve this same page and the same websocket messages.
