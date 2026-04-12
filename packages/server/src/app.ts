import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { AppDatabase, buildDbPath } from "./db.js";
import { GeminiService, getLevelById, getLessonSummary } from "./gemini.js";
import { handleLiveSocket } from "./live.js";
import type { AttemptRecord, LevelMode } from "./types.js";

export interface AppConfig {
  port: number;
  webOrigin: string;
  dataDir: string;
  geminiApiKey?: string;
  liveModel: string;
  scoreModel: string;
}

export function createApp(config: AppConfig) {
  mkdirSync(config.dataDir, { recursive: true });
  const recordingsDir = join(resolve(config.dataDir), "recordings");
  mkdirSync(recordingsDir, { recursive: true });

  const app = Fastify({
    logger: true,
    bodyLimit: 30 * 1024 * 1024
  });
  const db = new AppDatabase(buildDbPath(resolve(config.dataDir)));
  const gemini = new GeminiService({
    apiKey: config.geminiApiKey,
    liveModel: config.liveModel,
    scoreModel: config.scoreModel
  });

  void app.register(cors, {
    origin: [config.webOrigin]
  });
  void app.register(multipart);
  void app.register(websocket);

  app.get("/api/health", async () => ({
    ok: true,
    geminiEnabled: gemini.enabled
  }));

  app.get("/api/lesson", async () => {
    const progress = db.getAllProgress();
    return {
      lesson: getLessonSummary(),
      progress,
      geminiEnabled: gemini.enabled
    };
  });

  app.post("/api/attempts", async (request, reply) => {
    const schema = z.object({
      levelId: z.string(),
      mode: z.enum(["speech", "recital"])
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ message: "参数不完整。" });
    }

    const level = getLevelById(parsed.data.levelId);
    if (!level) {
      return reply.status(404).send({ message: "关卡不存在。" });
    }

    const mode = (parsed.data.mode || level.mode) as LevelMode;
    const now = new Date().toISOString();
    const attempt: AttemptRecord = {
      id: crypto.randomUUID(),
      levelId: level.id,
      mode,
      status: "recording",
      createdAt: now,
      updatedAt: now
    };
    db.createAttempt(attempt);
    return { attempt };
  });

  app.get("/api/attempts/:id/result", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const attempt = db.getAttempt(params.id);
    if (!attempt) {
      return reply.status(404).send({ message: "未找到该次闯关记录。" });
    }
    return { attempt };
  });

  app.get("/api/history", async () => {
    return {
      history: db.getHistory()
    };
  });

  app.get("/recordings/:file", async (request, reply) => {
    const params = z.object({ file: z.string() }).parse(request.params);
    const targetPath = join(recordingsDir, params.file);
    if (!existsSync(targetPath)) {
      return reply.status(404).send({ message: "录音文件不存在。" });
    }

    reply.type("audio/wav");
    return reply.send(createReadStream(targetPath));
  });

  app.post("/api/attempts/:id/audio", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const attempt = db.getAttempt(params.id);
    if (!attempt) {
      return reply.status(404).send({ message: "闯关记录不存在。" });
    }

    const parts = request.parts();
    let audioBuffer: Buffer | undefined;
    let liveTranscript = "";
    let durationMs = 0;
    let transcriptHint = "";

    for await (const part of parts) {
      if (part.type === "file" && part.fieldname === "audio") {
        audioBuffer = await part.toBuffer();
      }

      if (part.type === "field" && part.fieldname === "liveTranscript") {
        liveTranscript = String(part.value ?? "");
      }

      if (part.type === "field" && part.fieldname === "durationMs") {
        durationMs = Number(part.value ?? 0);
      }

      if (part.type === "field" && part.fieldname === "transcriptHint") {
        transcriptHint = String(part.value ?? "");
      }
    }

    if (!audioBuffer) {
      return reply.status(400).send({ message: "缺少音频文件。" });
    }

    const targetPath = join(recordingsDir, `${params.id}.wav`);
    writeFileSync(targetPath, audioBuffer);
    db.saveAttemptAudio(params.id, `/recordings/${params.id}.wav`, durationMs);

    const level = getLevelById(attempt.levelId);
    if (!level) {
      return reply.status(404).send({ message: "关联关卡不存在。" });
    }

    const score = await gemini.evaluateAttempt({
      level,
      audioPath: targetPath,
      liveTranscript,
      transcriptHint
    });

    db.saveScore(params.id, {
      status: "scored",
      score,
      transcript: score.transcript ?? transcriptHint,
      liveTranscript
    });

    return {
      attempt: db.getAttempt(params.id)
    };
  });

  app.get(
    "/api/live/:attemptId",
    { websocket: true },
    async (connection, request) => {
      const params = z.object({ attemptId: z.string() }).parse(request.params);
      const query = z.object({ levelId: z.string() }).parse(request.query);
      await handleLiveSocket(connection, params.attemptId, query.levelId, {
        db,
        logger: app.log,
        geminiClient: gemini.getLiveClient(),
        liveModel: gemini.getLiveModel()
      });
    }
  );

  const serverDir = fileURLToPath(new URL(".", import.meta.url));
  const webDist = resolve(serverDir, "../../web/dist");
  if (existsSync(webDist)) {
    void app.register(fastifyStatic, {
      root: webDist,
      prefix: "/"
    });
    app.get("/", async (_, reply) => reply.sendFile("index.html"));
  }

  return app;
}
