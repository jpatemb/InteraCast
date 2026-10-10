// Turns the (echo-cancelled) mic signal into 16-bit PCM chunks for streaming speech recognition,
// and reports a loudness level so the page can duck the narrator the moment you start talking.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.size = 0;
    this.sumSquares = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    const pcm = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.sumSquares += s * s;
    }
    this.buffer.push(pcm);
    this.size += pcm.length;
    // ~100 ms per message keeps latency low without flooding the socket.
    if (this.size >= sampleRate / 10) {
      const out = new Int16Array(this.size);
      let offset = 0;
      for (const chunk of this.buffer) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      const level = Math.sqrt(this.sumSquares / out.length);
      this.buffer = [];
      this.size = 0;
      this.sumSquares = 0;
      this.port.postMessage({ pcm: out.buffer, level }, [out.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
