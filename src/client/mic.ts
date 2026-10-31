import { bytesToBase64 } from "./lib";

type SpeechRec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function speechRecognition(): SpeechRec | null {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  return rec;
}

declare global {
  interface Window {
    webkitSpeechRecognition?: new () => SpeechRec;
    SpeechRecognition?: new () => SpeechRec;
  }
}

export class MicCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private speaking = false;
  private hangover: number | null = null;
  private preroll: Int16Array[] = [];
  private seq = 0;
  private utteranceId = "";
  private hint = "";
  private recognition: SpeechRec | null = null;
  private stopped = true;

  async listDevices(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "audioinput");
  }

  async start(options: {
    deviceId?: string;
    threshold: number;
    language?: string;
    onPcm: (payload: { pcm: string; seq: number; utteranceId: string; end: boolean; hint?: string }) => void;
    onLevel: (level: number, speaking: boolean) => void;
  }): Promise<void> {
    this.stop();
    this.stopped = false;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    this.context = new AudioContext();
    if (this.context.state === "suspended") await this.context.resume();
    const source = this.context.createMediaStreamSource(this.stream);
    const processor = this.context.createScriptProcessor(2048, 1, 1);
    const mute = this.context.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute);
    mute.connect(this.context.destination);
    this.processor = processor;
    this.recognition = speechRecognition();
    if (this.recognition) {
      this.recognition.lang = options.language || "en-US";
      this.recognition.onresult = (event) => {
        let text = "";
        for (let i = 0; i < event.results.length; i += 1) text += event.results[i][0].transcript;
        this.hint = text.trim();
      };
      this.recognition.onend = () => {
        if (!this.stopped) {
          try {
            this.recognition?.start();
          } catch {
            /* already started */
          }
        }
      };
      try {
        this.recognition.start();
      } catch {
        this.recognition = null;
      }
    }
    processor.onaudioprocess = (event) => {
      if (this.stopped || !this.context) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm = downsample(input, this.context.sampleRate, 16000);
      let energy = 0;
      for (let i = 0; i < input.length; i += 1) energy += input[i] * input[i];
      const level = Math.sqrt(energy / input.length);
      const hot = level >= options.threshold;
      this.preroll.push(pcm);
      if (this.preroll.length > 3) this.preroll.shift();
      if (hot) {
        if (this.hangover) window.clearTimeout(this.hangover);
        this.hangover = window.setTimeout(() => {
          if (!this.speaking) return;
          this.speaking = false;
          this.emit(new Int16Array(0), true, options.onPcm);
        }, 700);
        if (!this.speaking) {
          this.speaking = true;
          this.utteranceId = crypto.randomUUID();
          this.seq = 0;
          for (const frame of this.preroll) this.emit(frame, false, options.onPcm);
        } else {
          this.emit(pcm, false, options.onPcm);
        }
      }
      options.onLevel(level, this.speaking);
    };
  }

  stop(): void {
    this.stopped = true;
    if (this.hangover) window.clearTimeout(this.hangover);
    this.recognition?.stop();
    this.recognition = null;
    this.processor?.disconnect();
    this.processor = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    void this.context?.close();
    this.context = null;
    this.speaking = false;
    this.preroll = [];
  }

  private emit(
    pcm: Int16Array,
    end: boolean,
    onPcm: (payload: { pcm: string; seq: number; utteranceId: string; end: boolean; hint?: string }) => void,
  ): void {
    if (!this.utteranceId) return;
    if (pcm.length === 0 && !end) return;
    this.seq += 1;
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    onPcm({
      pcm: bytes.length ? bytesToBase64(bytes) : "",
      seq: this.seq,
      utteranceId: this.utteranceId,
      end,
      hint: end ? this.hint : undefined,
    });
    if (end) this.hint = "";
  }
}

function downsample(input: Float32Array, inRate: number, outRate: number): Int16Array {
  if (inRate === outRate) return floatTo16(input);
  const ratio = inRate / outRate;
  const length = Math.floor(input.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    const sample = sum / Math.max(1, end - start);
    out[i] = Math.max(-32767, Math.min(32767, Math.round(sample * 32767)));
  }
  return out;
}

function floatTo16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) out[i] = Math.max(-32767, Math.min(32767, Math.round(input[i] * 32767)));
  return out;
}
