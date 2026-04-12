class PcmRecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) {
      return true;
    }

    const channel = input[0];
    this.port.postMessage({
      samples: channel.slice(0)
    });
    return true;
  }
}

registerProcessor("pcm-recorder-processor", PcmRecorderProcessor);

