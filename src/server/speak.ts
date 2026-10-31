import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { language, ENGLISH } from "../shared/languages";
import { log } from "./log";
import { toneWav, wavDurationSeconds } from "./wav";

let espeakAvailable: boolean | null = null;

export function voiceFor(code: string): string {
  if (code === "en") return ENGLISH.espeak;
  return language(code)?.espeak || "en-us";
}

export async function synthesizeSpeech(text: string, langCode: string): Promise<{
  bytes: Buffer;
  mime: "audio/wav";
  sampleRate: number;
  seconds: number;
  engine: "espeak-ng" | "tone";
}> {
  const spoken = text.trim().slice(0, 4000);
  if (!spoken) {
    const bytes = toneWav(400);
    return { bytes, mime: "audio/wav", sampleRate: 16000, seconds: wavDurationSeconds(bytes), engine: "tone" };
  }
  if (espeakAvailable !== false) {
    try {
      const bytes = await espeak(voiceFor(langCode), spoken);
      espeakAvailable = true;
      return { bytes, mime: "audio/wav", sampleRate: readSampleRate(bytes), seconds: wavDurationSeconds(bytes), engine: "espeak-ng" };
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (missing) {
        espeakAvailable = false;
        log("espeak-unavailable", { message: error instanceof Error ? error.message : String(error) });
      } else {
        try {
          const bytes = await espeak("en-us", spoken);
          return { bytes, mime: "audio/wav", sampleRate: readSampleRate(bytes), seconds: wavDurationSeconds(bytes), engine: "espeak-ng" };
        } catch (fallback) {
          log("espeak-failed", { message: fallback instanceof Error ? fallback.message : String(fallback) });
        }
      }
    }
  }
  const ms = Math.min(8000, Math.max(500, spoken.length * 70));
  const bytes = toneWav(ms);
  return { bytes, mime: "audio/wav", sampleRate: 16000, seconds: wavDurationSeconds(bytes), engine: "tone" };
}

function readSampleRate(wav: Buffer): number {
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 16 <= wav.length) return wav.readUInt32LE(offset + 12);
    offset += 8 + size + (size % 2);
  }
  return 22050;
}

function espeak(voice: string, text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    mkdtemp(path.join(tmpdir(), "tourmania-"))
      .then((dir) => {
        const file = path.join(dir, "speech.wav");
        const child = spawn("espeak-ng", ["-v", voice, "-s", "150", "-w", file, "--stdin"], {
          stdio: ["pipe", "ignore", "pipe"],
        });
        let err = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 20_000);
        child.stderr.on("data", (chunk) => {
          err += chunk.toString();
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            rm(dir, { recursive: true, force: true }).catch(() => undefined);
            reject(new Error(err.trim() || `espeak-ng exited ${code}`));
            return;
          }
          readFile(file)
            .then((buf) => {
              rm(dir, { recursive: true, force: true }).catch(() => undefined);
              resolve(buf);
            })
            .catch(reject);
        });
        child.stdin.write(text);
        child.stdin.end();
      })
      .catch(reject);
  });
}
