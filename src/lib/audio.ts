/** WebView2 录音：getUserMedia → WebAudio → 16k/16bit/mono PCM。主窗与悬浮窗共用。 */

export interface PcmRecorder {
  stop(): Promise<Uint8Array>;
  cancel(): void;
}

function encodePcm16k(chunks: Float32Array[], sampleRate: number): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  const ratio = sampleRate / 16000;
  const outLen = Math.max(1, Math.floor(merged.length / ratio));
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = merged[i0] ?? 0;
    const b = merged[i0 + 1] ?? a;
    const s = Math.max(-1, Math.min(1, a * (1 - frac) + b * frac));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(pcm.buffer);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

export async function startPcmRecorder(): Promise<PcmRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (e) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(ctx.destination);

  let closed = false;
  async function cleanup() {
    if (closed) return;
    closed = true;
    try {
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
    } catch {
      /* ignore */
    }
  }

  return {
    async stop() {
      const sampleRate = ctx.sampleRate;
      const captured = chunks.slice();
      await cleanup();
      return encodePcm16k(captured, sampleRate);
    },
    cancel() {
      void cleanup();
    },
  };
}
