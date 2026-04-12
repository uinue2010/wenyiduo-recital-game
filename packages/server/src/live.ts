import type { FastifyBaseLogger } from "fastify";
import type { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { getLevelById } from "./gemini.js";
import type { AppDatabase } from "./db.js";

interface SocketLike {
  send(data: string): void;
  close(): void;
  on(event: "message", listener: (data: Buffer) => void | Promise<void>): void;
  on(event: "close", listener: () => void | Promise<void>): void;
}

interface LiveClientMessage {
  type: "start" | "audio" | "end" | "close";
  sampleRate?: number;
  mimeType?: string;
  audioBase64?: string;
}

interface LiveStreamDeps {
  db: AppDatabase;
  logger: FastifyBaseLogger;
  geminiClient?: GoogleGenAI;
  liveModel: string;
}

export async function handleLiveSocket(
  connection: { socket: SocketLike },
  attemptId: string,
  levelId: string,
  deps: LiveStreamDeps
) {
  const attempt = deps.db.getAttempt(attemptId);
  const level = getLevelById(levelId);
  if (!attempt || !level) {
    connection.socket.send(
      JSON.stringify({ type: "error", message: "未找到对应的闯关记录或关卡。" })
    );
    connection.socket.close();
    return;
  }

  if (!deps.geminiClient) {
    connection.socket.send(
      JSON.stringify({
        type: "ready",
        message: "当前未配置 Gemini API Key，实时转写将以本地占位模式运行。"
      })
    );
    let transcript = "";
    connection.socket.on("message", (buffer: Buffer) => {
      const payload = JSON.parse(buffer.toString()) as LiveClientMessage;
      if (payload.type === "audio") {
        transcript = transcript ? `${transcript} …` : "正在聆听中…";
        deps.db.updateAttemptLiveTranscript(attemptId, transcript);
        connection.socket.send(JSON.stringify({ type: "transcript", text: transcript }));
      }
      if (payload.type === "end" || payload.type === "close") {
        connection.socket.send(JSON.stringify({ type: "done" }));
        connection.socket.close();
      }
    });
    return;
  }

  const prompt = [
    "你正在监听一名中国初中生朗读闻一多《最后一次讲演》中的一个段落。",
    "你的唯一任务是将学生当前朗读内容转写成简体中文，供页面即时显示。",
    "不要评分，不要解释，不要补充。",
    `当前关卡：${level.title}`,
    `标准段落：${level.paragraph}`
  ].join("\n");

  try {
    const { Modality } = await import("@google/genai");
    const session = await deps.geminiClient.live.connect({
      model: deps.liveModel,
      callbacks: {
        onopen: () => {
          connection.socket.send(JSON.stringify({ type: "ready" }));
        },
        onmessage: (message: LiveServerMessage) => {
          const transcript = extractTranscript(message);
          if (transcript) {
            deps.db.updateAttemptLiveTranscript(attemptId, transcript);
            connection.socket.send(JSON.stringify({ type: "transcript", text: transcript }));
          }
        },
        onerror: (error: Error) => {
          deps.logger.error(error, "Gemini live session error");
          connection.socket.send(
            JSON.stringify({ type: "error", message: "实时转写连接失败，请稍后重试。" })
          );
        },
        onclose: () => {
          connection.socket.send(JSON.stringify({ type: "done" }));
        }
      },
      config: {
        responseModalities: [Modality.TEXT as Modality],
        inputAudioTranscription: {},
        systemInstruction: prompt
      }
    });

    connection.socket.on("message", async (buffer: Buffer) => {
      const payload = JSON.parse(buffer.toString()) as LiveClientMessage;

      if (payload.type === "start") {
        session.sendClientContent({
          turns: [{ role: "user", parts: [{ text: "开始监听当前朗读。" }] }],
          turnComplete: true
        });
        return;
      }

      if (payload.type === "audio" && payload.audioBase64) {
        session.sendRealtimeInput({
          audio: {
            data: payload.audioBase64,
            mimeType:
              payload.mimeType ??
              `audio/pcm;rate=${payload.sampleRate && payload.sampleRate > 0 ? payload.sampleRate : 16000}`
          }
        });
        return;
      }

      if (payload.type === "end") {
        session.sendRealtimeInput({ activityEnd: {} });
        return;
      }

      if (payload.type === "close") {
        await session.close();
      }
    });

    connection.socket.on("close", async () => {
      try {
        await session.close();
      } catch (error) {
        deps.logger.warn(error, "Live session close warning");
      }
    });
  } catch (error) {
    deps.logger.error(error, "Failed to start Gemini Live session");
    connection.socket.send(
      JSON.stringify({ type: "error", message: "实时转写启动失败，请检查 API 配置。" })
    );
    connection.socket.close();
  }
}

function extractTranscript(message: LiveServerMessage) {
  const typedMessage = message as Record<string, any>;
  return (
    typedMessage?.serverContent?.inputTranscription?.text ||
    typedMessage?.serverContent?.input_transcription?.text ||
    typedMessage?.serverContent?.outputTranscription?.text ||
    typedMessage?.serverContent?.output_transcription?.text ||
    typedMessage?.serverContent?.modelTurn?.parts?.find((part: Record<string, unknown>) =>
      typeof part.text === "string"
    )?.text ||
    ""
  );
}
