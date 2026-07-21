'use strict';

class AriPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.input = [];
    this.pending = [];
    this.position = 0;
    this.levelCounter = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;
    let energy = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const value = Math.max(-1, Math.min(1, channel[i]));
      this.input.push(value);
      energy += value * value;
    }
    const step = sampleRate / 16000;
    while (this.position + 1 < this.input.length) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      const value = this.input[left] + (this.input[left + 1] - this.input[left]) * fraction;
      this.pending.push(Math.max(-32768, Math.min(32767, Math.round(value * 32767))));
      this.position += step;
    }
    const consumed = Math.floor(this.position);
    if (consumed > 0) {
      this.input.splice(0, consumed);
      this.position -= consumed;
    }
    while (this.pending.length >= 800) {
      const pcm = new Int16Array(this.pending.splice(0, 800));
      this.port.postMessage({ type: 'audio', buffer: pcm.buffer }, [pcm.buffer]);
    }
    this.levelCounter += channel.length;
    if (this.levelCounter >= sampleRate / 10) {
      this.levelCounter = 0;
      this.port.postMessage({ type: 'level', value: Math.min(1, Math.sqrt(energy / channel.length) * 5) });
    }
    return true;
  }
}

registerProcessor('ari-pcm-processor', AriPcmProcessor);
