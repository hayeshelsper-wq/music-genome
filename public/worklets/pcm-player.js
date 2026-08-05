// AudioWorklet PCM player for the crossfader stream: a Float32 ring buffer
// (~30s capacity per channel) fed from the main thread; process() pulls
// 128-frame quanta; underruns emit silence and report a counter so the UI can
// show a buffering indicator.

const RING_SECONDS = 30;

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = sampleRate * RING_SECONDS;
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.readPos = 0;
    this.writePos = 0;
    this.available = 0;
    this.underruns = 0;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "push") {
        const l = msg.left;
        const r = msg.right;
        for (let i = 0; i < l.length; i++) {
          if (this.available >= this.capacity) break; // ring full: drop oldest-newest? drop incoming
          this.left[this.writePos] = l[i];
          this.right[this.writePos] = r[i];
          this.writePos = (this.writePos + 1) % this.capacity;
          this.available++;
        }
        this.port.postMessage({ type: "level", available: this.available });
      } else if (msg.type === "reset") {
        this.readPos = 0;
        this.writePos = 0;
        this.available = 0;
        this.underruns = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const l = out[0];
    const r = out.length > 1 ? out[1] : out[0];
    const n = l.length;
    if (this.available < n) {
      l.fill(0);
      r.fill(0);
      this.underruns++;
      this.port.postMessage({
        type: "underrun",
        underruns: this.underruns,
        available: this.available,
      });
      return true;
    }
    for (let i = 0; i < n; i++) {
      l[i] = this.left[this.readPos];
      r[i] = this.right[this.readPos];
      this.readPos = (this.readPos + 1) % this.capacity;
    }
    this.available -= n;
    return true;
  }
}

registerProcessor("pcm-player", PcmPlayer);
