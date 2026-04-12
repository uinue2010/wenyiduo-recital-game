import { readFileSync } from "node:fs";
import { GoogleGenAI, Type } from "@google/genai";
import { lessonConfig } from "./lesson.js";
import { estimateAudioMetrics } from "./audio.js";
import type {
  LevelConfig,
  LevelMode,
  ScoreReport,
  ScoreDimension,
  TimedFeedbackItem
} from "./types.js";

interface EvaluateInput {
  level: LevelConfig;
  audioPath: string;
  liveTranscript?: string;
  transcriptHint?: string;
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
              pass: { type: Type.BOOLEAN },
              mode: { type: Type.STRING, enum: ["speech", "recital"] },
              summary: { type: Type.STRING },
              dimensions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    maxScore: { type: Type.NUMBER },
                    score: { type: Type.NUMBER },
                    comment: { type: Type.STRING }
                  },
                  required: ["name", "maxScore", "score", "comment"]
                }
              },
              strengths: {
                type: Type.ARRAY,
                items: { type: Type.STRING }
              },
              improvements: {
                type: Type.ARRAY,
                items: { type: Type.STRING }
              },
              lineFeedback: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    label: { type: Type.STRING },
                    advice: { type: Type.STRING },
                    timeSeconds: { type: Type.NUMBER }
                  },
                  required: ["label", "advice"]
                }
              },
              practiceTip: { type: Type.STRING },
              transcript: { type: Type.STRING },
              accuracyNotes: { type: Type.STRING }
            },
            required: [
              "totalScore",
              "pass",
              "mode",
              "summary",
              "dimensions",
              "strengths",
              "improvements",
              "lineFeedback",
              "practiceTip"
            ]
          }
        }
      });

      const rawText = response.text ?? "{}";
      const parsed = JSON.parse(rawText) as Omit<ScoreReport, "verdict" | "engine">;
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

    const dimensions = buildMockDimensions(
      input.level.mode,
      accuracyScore,
      audioEnergyScore,
      pacingScore,
      emotionBonus
    );
    const totalScore = dimensions.reduce((sum, item) => sum + item.score, 0);

    const improvements = [];
    if (accuracyRatio < 0.9) {
      improvements.push("文本存在漏读或替换词，建议对照原文逐句精读后再挑战。");
    }
    if (metrics.rms < 0.05) {
      improvements.push("整体声音偏轻，关键句应再向前推出，增强现场感染力。");
    }
    if (metrics.silenceRatio > 0.65) {
      improvements.push("停顿略碎，建议先划分语意群，再按整句推进。");
    }
    while (improvements.length < 2) {
      improvements.push("重音词还可以更突出，尤其是立场鲜明的判断句。");
    }

    const strengths = [];
    if (metrics.peak > 0.2) {
      strengths.push("情绪起点比较鲜明，关键句有一定冲击力。");
    }
    if (accuracyRatio >= 0.9) {
      strengths.push("文本熟练度较好，主要句群基本保持完整。");
    }
    while (strengths.length < 2) {
      strengths.push("整体节奏尚稳，能够完成一段完整表达。");
    }

    return sanitizeReport(
      {
        totalScore,
        pass: totalScore >= input.level.passScore,
        mode: input.level.mode,
        summary:
          totalScore >= input.level.passScore
            ? "这一段已经有比赛朗读的雏形，气势和文本控制基本到位。"
            : totalScore >= 70
              ? "这一段完成度不错，但离通关还差一点临门一脚。"
              : "这一段的基础已经有了，接下来重点补强重音、节奏和文本准确度。",
        dimensions,
        strengths,
        improvements,
        lineFeedback: [
          {
            label: "开头起势",
            advice:
              input.level.mode === "speech"
                ? "第一句再果断一些，像当众发问而不是平读叙述。"
                : "第一句先稳后扬，把气口和重音先铺出来。"
          },
          {
            label: "关键判断句",
            advice: "遇到“无耻”“光荣”“胜利”等词时，要敢于拉开轻重。 "
          }
        ],
        practiceTip: "下次练习先做一遍慢速划重音，再按比赛速度完整读一遍。",
        transcript,
        accuracyNotes:
          accuracyRatio >= 0.9
            ? "文本准确度较好。"
            : "检测到可能存在漏读、替换词或停顿导致的识别偏差。"
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
    "2. 点评语气要像比赛评委，专业、具体、有建设性。",
    "3. strengths 至少 2 条，improvements 至少 2 条，lineFeedback 至少 2 条。",
    "4. lineFeedback 可以按句子片段或时间点给建议。",
    "5. 如果存在错漏字、停顿问题或情绪不到位，请明确指出。",
    "6. summary 用 1 句总评，practiceTip 用 1 条下一次复练指令。"
  ]
    .filter(Boolean)
    .join("\n");
}

function buildMockDimensions(
  mode: LevelMode,
  accuracyScore: number,
  audioEnergyScore: number,
  pacingScore: number,
  emotionBonus: number
): ScoreDimension[] {
  if (mode === "speech") {
    return [
      {
        name: "文本准确度",
        maxScore: 20,
        score: accuracyScore,
        comment: accuracyScore >= 16 ? "文本基本准确。" : "存在漏读或替换词。"
      },
      {
        name: "语气重音",
        maxScore: 20,
        score: clamp(audioEnergyScore, 8, 20),
        comment: "关键词可再压重，反问句更要推出锋芒。"
      },
      {
        name: "停连节奏",
        maxScore: 15,
        score: clamp(Math.round(pacingScore * 0.8), 6, 15),
        comment: "句间可再拉开层次，避免碎停顿。"
      },
      {
        name: "情感与感染力",
        maxScore: 25,
        score: clamp(emotionBonus + 5, 10, 25),
        comment: "情绪方向对了，但情感峰值还可以更集中。"
      },
      {
        name: "整体台风/气势",
        maxScore: 20,
        score: clamp(audioEnergyScore + 2, 8, 20),
        comment: "整体表达完整，若更果断会更有现场感。"
      }
    ];
  }

  return [
    {
      name: "文本准确度",
      maxScore: 20,
      score: accuracyScore,
      comment: accuracyScore >= 16 ? "文本完整度较好。" : "建议再次对照原文细读。"
    },
    {
      name: "吐字归音",
      maxScore: 20,
      score: clamp(audioEnergyScore + 1, 8, 20),
      comment: "个别字词可更清楚，句尾收音还可更利落。"
    },
    {
      name: "停连节奏",
      maxScore: 20,
      score: clamp(pacingScore, 8, 20),
      comment: "节奏整体稳定，但层次还可更鲜明。"
    },
    {
      name: "情感层次",
      maxScore: 25,
      score: clamp(emotionBonus + 6, 10, 25),
      comment: "情感方向明确，转折处可以再拉开一档。"
    },
    {
      name: "整体表现",
      maxScore: 15,
      score: clamp(Math.round((audioEnergyScore + pacingScore) / 2), 7, 15),
      comment: "段落完整，整体完成度不错。"
    }
  ];
}

function sanitizeReport(
  report: Omit<ScoreReport, "verdict" | "engine">,
  mode: LevelMode,
  engine: "gemini" | "mock"
): ScoreReport {
  const dimensions = (report.dimensions ?? []).map((item) => ({
    ...item,
    score: clamp(Math.round(item.score), 0, Math.round(item.maxScore))
  }));
  const totalScore =
    report.totalScore != null
      ? clamp(Math.round(report.totalScore), 0, 100)
      : dimensions.reduce((sum, item) => sum + item.score, 0);
  const pass = totalScore >= 85;
  const verdict = pass ? "pass" : totalScore >= 70 ? "near_pass" : "retry";
  return {
    totalScore,
    pass,
    mode,
    summary: report.summary ?? "",
    dimensions,
    strengths: normalizeList(report.strengths, 2),
    improvements: normalizeList(report.improvements, 2),
    lineFeedback: normalizeFeedback(report.lineFeedback),
    practiceTip: report.practiceTip ?? "建议再完整朗读一遍，并重点修正点评中提到的高频问题。",
    transcript: report.transcript,
    accuracyNotes: report.accuracyNotes,
    verdict,
    engine
  };
}

function normalizeList(items: string[] | undefined, minItems: number) {
  const normalized = (items ?? []).map((item) => item.trim()).filter(Boolean);
  while (normalized.length < minItems) {
    normalized.push("整体表现有基础，但还需要更有针对性的复练。");
  }
  return normalized;
}

function normalizeFeedback(items: TimedFeedbackItem[] | undefined) {
  const normalized = (items ?? []).filter((item) => item?.label && item?.advice);
  while (normalized.length < 2) {
    normalized.push({
      label: `建议 ${normalized.length + 1}`,
      advice: "先划出重音和停顿，再做一遍完整朗读。"
    });
  }
  return normalized;
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
