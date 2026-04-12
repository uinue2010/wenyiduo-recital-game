import { useEffect, useRef, useState } from "react";
import { getApiBaseUrl } from "./api";

interface RecorderStartInput {
  attemptId: string;
  levelId: string;
}

interface RecorderResult {
  audioBlob: Blob;
  durationMs: number;
  transcript: string;
}

function toWebSocketUrl(httpUrl: string) {
  return httpUrl.startsWith("https:")
    ? httpUrl.replace("https:", "wss:")
    : httpUrl.replace("http:", "ws:");
}

export function useRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [statusText, setStatusText] = useState("待命中");
  const [transcript, setTranscript] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sampleRateRef = useRef<number>(16000);
  const allChunksRef = useRef<Float32Array[]>([]);
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      void cleanup();
    };
  }, []);

  async function start(input: RecorderStartInput) {
    setError(null);
    setTranscript("");
    setElapsedMs(0);
    allChunksRef.current = [];
    startTimeRef.current = performance.now();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          noiseSuppression: false,
          echoCancellation: false,
          autoGainControl: false
        }
      });

      const audioContext = new AudioContext();
      await audioContext.audioWorklet.addModule("/pcm-recorder-processor.js");

      const source = audioContext.createMediaStreamSource(stream);
      const processor = new AudioWorkletNode(audioContext, "pcm-recorder-processor");
      const gain = audioContext.createGain();
      gain.gain.value = 0;

      source.connect(processor);
      processor.connect(gain);
      gain.connect(audioContext.destination);

      const socket = new WebSocket(
        `${toWebSocketUrl(getApiBaseUrl())}/api/live/${input.attemptId}?levelId=${input.levelId}`
      );

      socket.onopen = () => {
        setStatusText("实时转写连接成功，开始聆听");
        socket.send(
          JSON.stringify({
            type: "start",
            sampleRate: audioContext.sampleRate
          })
        );
      };

      socket.onmessage = (event) => {
        const payload = JSON.parse(event.data) as {
          type: string;
          text?: string;
          message?: string;
        };
        if (payload.type === "ready") {
          setStatusText(payload.message ?? "实时转写已就绪");
        }
        if (payload.type === "transcript") {
          setTranscript(payload.text ?? "");
        }
        if (payload.type === "error") {
          setError(payload.message ?? "实时转写出现错误。");
        }
        if (payload.type === "done") {
          setStatusText("实时转写已结束");
        }
      };

      socket.onerror = () => {
        setError("实时转写连接失败，请重试。");
      };

      processor.port.onmessage = (event) => {
        const floatChunk = new Float32Array(event.data.samples);
        allChunksRef.current.push(floatChunk);
        if (socket.readyState === WebSocket.OPEN) {
          const chunk16 = float32ToInt16(floatChunk);
          socket.send(
            JSON.stringify({
              type: "audio",
              sampleRate: audioContext.sampleRate,
              mimeType: `audio/pcm;rate=${audioContext.sampleRate}`,
              audioBase64: int16ToBase64(chunk16)
            })
          );
        }
      };

      sampleRateRef.current = audioContext.sampleRate;
      streamRef.current = stream;
      audioContextRef.current = audioContext;
      sourceRef.current = source;
      processorRef.current = processor;
      gainRef.current = gain;
      socketRef.current = socket;

      timerRef.current = window.setInterval(() => {
        setElapsedMs(Math.round(performance.now() - startTimeRef.current));
      }, 200);

      setIsRecording(true);
      setStatusText("正在录音");
    } catch (startError) {
      console.error(startError);
      setError("无法访问麦克风，请确认浏览器已授权。");
      await cleanup();
    }
  }

  async function stop(): Promise<RecorderResult | null> {
    if (!isRecording) {
      return null;
    }

    setStatusText("正在整理录音并提交评分");
    setIsRecording(false);

    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "end" }));
    }

    const sampleRate = sampleRateRef.current;
    const merged = mergeFloat32(allChunksRef.current);
    const resampled =
      sampleRate === 16000 ? merged : resampleFloat32(merged, sampleRate, 16000);
    const wavBlob = float32ToWavBlob(resampled, 16000);
    const durationMs = Math.round((resampled.length / 16000) * 1000);

    await cleanup();
    return {
      audioBlob: wavBlob,
      durationMs,
      transcript
    };
  }

  async function cleanup() {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }

    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    gainRef.current?.disconnect();

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (socketRef.current) {
      if (socketRef.current.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "close" }));
      }
      socketRef.current.close();
      socketRef.current = null;
    }

    if (audioContextRef.current) {
      await audioContextRef.current.close();
      audioContextRef.current = null;
    }

    sourceRef.current = null;
    processorRef.current = null;
    gainRef.current = null;
  }

  return {
    isRecording,
    statusText,
    transcript,
    elapsedMs,
    error,
    start,
    stop,
    reset() {
      setTranscript("");
      setElapsedMs(0);
      setError(null);
      setStatusText("待命中");
    }
  };
}

function mergeFloat32(chunks: Float32Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function float32ToInt16(floatChunk: Float32Array) {
  const result = new Int16Array(floatChunk.length);
  for (let index = 0; index < floatChunk.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, floatChunk[index]));
    result[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return result;
}

function int16ToBase64(data: Int16Array) {
  const bytes = new Uint8Array(data.buffer);
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function resampleFloat32(
  source: Float32Array,
  sourceRate: number,
  targetRate: number
) {
  if (sourceRate === targetRate) {
    return source;
  }

  const ratio = sourceRate / targetRate;
  const targetLength = Math.round(source.length / ratio);
  const result = new Float32Array(targetLength);
  for (let index = 0; index < targetLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(source.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let cursor = start; cursor < end; cursor += 1) {
      sum += source[cursor];
      count += 1;
    }
    result[index] = count === 0 ? source[start] ?? 0 : sum / count;
  }
  return result;
}

function float32ToWavBlob(samples: Float32Array, sampleRate: number) {
  const pcm = float32ToInt16(samples);
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, pcm.length * 2, true);

  const pcmBytes = new Uint8Array(buffer, 44);
  pcmBytes.set(new Uint8Array(pcm.buffer));
  return new Blob([buffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

