class MoVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new DataView(new ArrayBuffer(1920));
    this.offset = 0;
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (const sample of samples) {
      const pcm = Math.max(-1, Math.min(1, sample));
      this.frame.setInt16(this.offset, pcm * (pcm < 0 ? 32768 : 32767), true);
      this.offset += 2;
      if (this.offset === this.frame.byteLength) {
        const data = this.frame.buffer;
        this.port.postMessage(data, [data]);
        this.frame = new DataView(new ArrayBuffer(1920));
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('movoice-capture', MoVoiceCapture);
