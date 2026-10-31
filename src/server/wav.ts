export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function wavDurationSeconds(wav: Buffer): number {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF") return 0;
  let rate = 16000;
  let channels = 1;
  let bits = 16;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 24 <= wav.length) {
      channels = wav.readUInt16LE(offset + 10);
      rate = wav.readUInt32LE(offset + 12);
      bits = wav.readUInt16LE(offset + 22);
    } else if (id === "data") {
      dataBytes = Math.min(size, wav.length - (offset + 8));
      break;
    }
    offset += 8 + size + (size % 2);
  }
  const bytesPerSecond = rate * channels * (bits / 8);
  return bytesPerSecond > 0 ? dataBytes / bytesPerSecond : 0;
}

export function toneWav(durationMs: number, sampleRate = 16000): Buffer {
  const n = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 160, (n - i) / 160);
    const f = i < n / 2 ? 523.25 : 659.25;
    const s = Math.sin((2 * Math.PI * f * i) / sampleRate) * 0.28 * env;
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * 32767))), i * 2);
  }
  return pcmToWav(pcm, sampleRate);
}

export function pcmDurationSeconds(pcm: Buffer, sampleRate = 16000): number {
  return pcm.length / 2 / sampleRate;
}
