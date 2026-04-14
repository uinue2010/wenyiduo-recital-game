import { readFileSync } from "node:fs";
import { GoogleGenAI, Type } from "@google/genai";
import { lessonConfig } from "./lesson.js";
import { estimateAudioMetrics } from "./audio.js";
import type { LevelConfig, LevelMode, ScoreReport } from "./types.js";

interface EvaluateInput {
  level: LevelConfig;
  audioPath: string;
  liveTranscript?: string;
  transcriptHint?: string;
}

interface RawScoreReport {
  totalScore?: number;
  summary?: string;
  transcript?: string;
}

export class GeminiService {
  private readonly client?: GoogleGenAI;
  private readonly liveModel: string;
  private readonly scoreModel: string;
  readonly enabled: boolean;

  constructor(config: {
    apiKey?: string;
    liveModel: string;
    scoreModel: string;
  }) {
    this.enabled = Boolean(config.apiKey);
    this.liveModel = config.liveModel;
    this.scoreModel = config.scoreModel;
    this.client = config.apiKey ? new GoogleGenAI({ apiKey: config.apiKey }) : undefined;
  }

  getLiveModel() {
    return this.liveModel;
  }

  getLiveClient() {
    return this.client;
  }

  async evaluateAttempt(input: EvaluateInput): Promise<ScoreReport> {
    if (!this.client) {
      return this.mockEvaluate(input);
    }

    const wavBuffer = readFileSync(input.audioPath);
    const prompt = buildScoringPrompt(input.level, input.liveTranscript, input.transcriptHint);

    try {
      const response = await this.client.models.generateContent({
        model: this.scoreModel,
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: "audio/wav",
                  data: wavBuffer.toString("base64")
                }
              }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              totalScore: { type: Type.NUMBER },
              summary: { type: Type.STRING },
              transcript: { type: Type.STRING }
            },
            required: ["totalScore", "summary"]
          }
        }
      });

      const rawText = response.text ?? "{}";
      const parsed = JSON.parse(rawText) as RawScoreReport;
      return sanitizeReport(parsed, input.level.mode, "gemini");
    } catch (error) {
      console.error("Gemini scoring failed, falling back to mock evaluation.", error);
      return this.mockEvaluate(input);
    }
  }

  private mockEvaluate(input: EvaluateInput): ScoreReport {
    const wavBuffer = readFileSync(input.audioPath);
    const pcmData = new Int16Array(
      wavBuffer.buffer,
      wavBuffer.byteOffset + 44,
      Math.max(0, (wavBuffer.length - 44) / 2)
    );
    const metrics = estimateAudioMetrics(pcmData, 16000);
    const transcript = input.liveTranscript ?? input.transcriptHint ?? "";
    const normalizedSource = normalizeText(input.level.paragraph);
    const normalizedTranscript = normalizeText(transcript);
    const matchedChars = calculateOverlap(normalizedSource, normalizedTranscript);
    const accuracyRatio =
      normalizedSource.length === 0 ? 0.8 : matchedChars / normalizedSource.length;

    const audioEnergyScore = clamp(Math.round(metrics.rms * 1000), 0, 18);
    const pacingScore = clamp(18 - Math.abs(metrics.durationMs - 22000) / 2200, 8, 18);
    const accuracyScore = clamp(Math.round(accuracyRatio * 20), 8, 20);
    const emotionBonus =
      input.level.mode === "speech"
        ? clamp(Math.round(metrics.peak * 18), 10, 20)
        : clamp(Math.round(metrics.peak * 14 + (1 - metrics.silenceRatio) * 8), 8, 18);

    const totalScore = calculateMockTotal(
      input.level.mode,
      accuracyScore,
      audioEnergyScore,
      pacingScore,
      emotionBonus
    );

    return sanitizeReport(
      {
        totalScore,
        summary:
          totalScore >= input.level.passScore
            ? "这一遍整体完成度已经过关，语势和节奏比较稳，继续保持这种完整表达。"
            : totalScore >= 70
              ? "这一遍已经接近通关，气势有了，但重音和停顿还要更利落，下一遍会更稳。"
              : "这一遍基础已具备，但文本准确度和语气控制还不够稳定，先把整段读顺再加强情感。",   
        transcript,
      },
      input.level.mode,
      "mock"
    );
  }
}

function buildScoringPrompt(
  level: LevelConfig,
  liveTranscript?: string,
  transcriptHint?: string
) {
  const rubric =
    level.mode === "speech"
      ? [
          "文本准确度 20",
          "语气重音 20",
          "停连节奏 15",
          "情感与感染力 25",
          "整体台风/气势 20"
        ]
      : [
          "文本准确度 20",
          "吐字归音 20",
          "停连节奏 20",
          "情感层次 25",
          "整体表现 15"
        ];

  return [
    "你是一位中国中学朗诵比赛与演讲比赛的专业评委。",
    "请根据学生的原始音频给出结构化评分，必须以音频表现为主，不可只依据转写文字。",
    "任务背景：八年级下册《最后一次讲演》课堂闯关。",
    `当前关卡：${level.title}`,
    `评价模式：${level.mode === "speech" ? "演讲" : "朗诵"}`,
    `关卡重点：${level.focus}`,
    `通关线：${level.passScore}`,
    `标准文本：${level.paragraph}`,
    liveTranscript ? `实时转写参考：${liveTranscript}` : "",
    transcriptHint ? `附加转写参考：${transcriptHint}` : "",
    `评分维度：${rubric.join("；")}`,
    "输出要求：",
    "1. 评分必须符合各维度分值上限，总分为各维度之和。",
    "2. summary 只能输出一段中文总评，不要分点，不要拆成亮点和建议。",
    "3. summary 必须控制在 150 个汉字以内，语气像比赛评委，但要简洁克制。",
    "4. summary 只说整体判断，不要逐句展开，不要写维度拆解。",
    "5. 如果存在明显问题，只在这句总评里简要点到为止。"
  ]
    .filter(Boolean)
    .join("\n");
}

function calculateMockTotal(
  mode: LevelMode,
  accuracyScore: number,
  audioEnergyScore: number,
  pacingScore: number,
  emotionBonus: number
): number {
  if (mode === "speech") {
    return (
      accuracyScore +
      clamp(audioEnergyScore, 8, 20) +
      clamp(Math.round(pacingScore * 0.8), 6, 15) +
      clamp(emotionBonus + 5, 10, 25) +
      clamp(audioEnergyScore + 2, 8, 20)
    );
  }

  return (
    accuracyScore +
    clamp(audioEnergyScore + 1, 8, 20) +
    clamp(pacingScore, 8, 20) +
    clamp(emotionBonus + 6, 10, 25) +
    clamp(Math.round((audioEnergyScore + pacingScore) / 2), 7, 15)
  );
}

function sanitizeReport(
  report: RawScoreReport,
  mode: LevelMode,
  engine: "gemini" | "mock"
): ScoreReport {
  const totalScore =
    report.totalScore != null
      ? clamp(Math.round(report.totalScore), 0, 100)
      : 0;
  const pass = totalScore >= 85;
  const verdict = pass ? "pass" : totalScore >= 70 ? "near_pass" : "retry";
  return {
    totalScore,
    pass,
    mode,
    summary: normalizeSummary(report.summary),
    transcript: report.transcript,
    verdict,
    engine
  };
}

function normalizeSummary(summary?: string) {
  const text = (summary ?? "")
    .replace(/\s+/g, " ")
    .replace(/[：:]\s*/g, "，")
    .trim();
  if (!text) {
    return "这一遍已经完成，请继续保持整段表达的完整性和稳定度。";
  }

  const firstSentence =
    text.split(/(?<=[。！？!?])/u).find((item) => item.trim())?.trim() ?? text;
  const clipped = Array.from(firstSentence).slice(0, 150).join("").trim();
  if (/[。！？!?]$/u.test(clipped)) {
    return clipped;
  }
  return `${clipped}。`;
}

function normalizeText(text: string) {
  return text.replace(/[“”"'，。！？：；、\s]/g, "");
}

function calculateOverlap(source: string, target: string) {
  if (!source || !target) {
    return 0;
  }

  let matched = 0;
  let targetIndex = 0;
  for (const char of source) {
    const found = target.indexOf(char, targetIndex);
    if (found >= 0) {
      matched += 1;
      targetIndex = found + 1;
    }
  }
  return matched;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function getLevelById(levelId: string) {
  return lessonConfig.levels.find((level) => level.id === levelId);
}

export function getLessonSummary() {
  return {
    ...lessonConfig,
    levels: lessonConfig.levels.map((level) => ({
      ...level,
      rubric:
        level.mode === "speech"
          ? [
              { name: "文本准确度", maxScore: 20 },
              { name: "语气重音", maxScore: 20 },
              { name: "停连节奏", maxScore: 15 },
              { name: "情感与感染力", maxScore: 25 },
              { name: "整体台风/气势", maxScore: 20 }
            ]
          : [
              { name: "文本准确度", maxScore: 20 },
              { name: "吐字归音", maxScore: 20 },
              { name: "停连节奏", maxScore: 20 },
              { name: "情感层次", maxScore: 25 },
              { name: "整体表现", maxScore: 15 }
            ]
    }))
  };
}

export function getLessonForPrompt() {
  return lessonConfig;
}
