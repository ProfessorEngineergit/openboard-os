// AudioWorklet: forwards mono microphone frames to the main thread in blocks of 2048 samples.
class AstraRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(2048);
    this.fill = 0;
    this.done = false;
    this.port.onmessage = event => { if (event.data === 'stop') this.done = true; };
  }

  process(inputs) {
    if (this.done) return false;
    const channels = inputs[0];
    if (channels && channels.length) {
      const first = channels[0];
      const count = channels.length;
      for (let i = 0; i < first.length; i++) {
        let sample = first[i];
        if (count > 1) { for (let c = 1; c < count; c++) sample += channels[c][i]; sample /= count; }
        this.block[this.fill++] = sample;
        if (this.fill === this.block.length) {
          this.port.postMessage(this.block, [this.block.buffer]);
          this.block = new Float32Array(2048);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('astra-recorder', AstraRecorder);
