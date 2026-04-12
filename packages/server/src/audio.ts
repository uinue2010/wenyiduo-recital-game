export function pcm16ToWavBuffer(
  pcmData: Int16Array,
  sampleRate: number,
  numChannels = 1
) {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const byteRate = sampleRate * numChannels * 2;
  const blockAlign = numChannels * 2;
  const dataSize = pcmData.length * 2;

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  return Buffer.concat([Buffer.from(header), Buffer.from(pcmData.buffer)]);
}

function writeString(view: DataView, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

export function estimateAudioMetrics(pcmData: Int16Array, sampleRate: number) {
  if (pcmData.length === 0) {
    return {
      durationMs: 0,
      rms: 0,
      peak: 0,
      silenceRatio: 1
    };
  }

  let energy = 0;
  let peak = 0;
  let silenceSamples = 0;
  for (const sample of pcmData) {
    const normalized = Math.abs(sample) / 32768;
    energy += normalized * normalized;
    peak = Math.max(peak, normalized);
    if (normalized < 0.02) {
      silenceSamples += 1;
    }
  }

  return {
    durationMs: Math.round((pcmData.length / sampleRate) * 1000),
    rms: Math.sqrt(energy / pcmData.length),
    peak,
    silenceRatio: silenceSamples / pcmData.length
  };
}

