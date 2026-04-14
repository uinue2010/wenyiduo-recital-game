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
            ? "这一遍整体完成度已经过关，文本基本顺畅，语势也能立住，关键判断句有一定分量。后面如果把停顿收得更整、句尾收音再稳一点，整段表达会更像比赛里的成熟呈现，现场感还能再往上提。"
            : totalScore >= 70
              ? "这一遍已经接近通关，整体气势出来了，段落也能基本撑住，但重音落点和停顿处理还不够整齐，个别句子收得有些急。下一遍如果把关键词再压实一点，把语意群读得更连贯，分数会更稳定地往上走。"
              : "这一遍已经把基本框架读出来了，但文本准确度、语气控制和节奏完整性还不够稳，听起来会有些散。建议下一遍先把原文再顺一遍，按语意群处理停顿，再把重点词读得更鲜明，这样整体完成度会明显提高。",
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
    "3. summary 目标长度为 150 字左右，尽量控制在 130 到 170 个汉字之间，不要过短。",
    "4. 可以用 2 到 3 个短句组成一段完整总评，但仍然只输出这一段，不要列条目。",
    "5. summary 只说整体判断，不要逐句展开，不要写维度拆解。",
    "6. 如果存在明显问题，只在这段总评里简要点到为止。"
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
    summary: normalizeSummary(report.summary, totalScore, mode),
    transcript: report.transcript,
    verdict,
    engine
  };
}

function normalizeSummary(summary: string | undefined, totalScore: number, mode: LevelMode) {
  const text = (summary ?? "")
    .replace(/\s+/g, " ")
    .replace(/[：:]\s*/g, "，")
    .trim();
  if (!text) {
    return buildFallbackSummary(totalScore, mode);
  }

  const sentenceParts = text
    .split(/(?<=[。！？!?])/u)
    .map((item) => item.trim())
    .filter(Boolean);

  let combined = "";
  for (const part of sentenceParts) {
    const candidate = `${combined}${part}`.trim();
    if (Array.from(candidate).length > 170) {
      break;
    }
    combined = candidate;
    if (Array.from(combined).length >= 130) {
      break;
    }
  }

  const base = combined || text;
  const clipped = Array.from(base).slice(0, 170).join("").trim();
  const completed = /[。！？!?]$/u.test(clipped) ? clipped : `${clipped}。`;

  if (Array.from(completed).length >= 120) {
    return completed;
  }

  const fallbackTail = buildFallbackTail(totalScore, mode);
  const extended = `${completed}${fallbackTail}`;
  const finalText = Array.from(extended).slice(0, 170).join("").trim();
  return /[。！？!?]$/u.test(finalText) ? finalText : `${finalText}。`;
}

function buildFallbackSummary(totalScore: number, mode: LevelMode) {
  if (totalScore >= 85) {
    return mode === "speech"
      ? "这一遍整体表达已经比较完整，语势能立住，关键句也有一定力度，能让人听出你的态度和立场。后面如果把停顿收得更整、重音放得更准一些，整段讲演会更有现场感染力，比赛感也会更明显。"
      : "这一遍整体朗读已经比较完整，文本推进顺畅，情感方向也是对的，听起来有一定层次和起伏。接下来如果把字音再咬实一点，把句间停连处理得更自然，整段作品会更有沉浸感，也更接近比赛里的成熟呈现。";
  }

  if (totalScore >= 70) {
    return mode === "speech"
      ? "这一遍已经接近通关，整体气势有了，段落也能基本撑住，但重音落点和语句停顿还不够整，听感上还差一点凝聚力。下一遍只要把关键词再压实，把句与句之间带得更顺，分数就会明显更稳。"
      : "这一遍已经接近通关，整体节奏和情感方向都出来了，但有些地方转折还不够清楚，句尾收得也略急，所以听起来还差一点完整度。下一遍把停连再理顺，把重点词读得更鲜明一些，整体效果会立刻提升。";
  }

  return mode === "speech"
    ? "这一遍已经把基本框架读出来了，但文本准确度、语气控制和节奏完整性还不够稳定，所以整体力量感还没有真正立起来。建议先把原文再顺一遍，按语意群处理停顿，再把关键判断句读得更坚决一些，进步会非常明显。"
    : "这一遍已经有了基本朗读状态，但文本熟练度、吐字清晰度和节奏连贯性还不够稳定，所以整段听起来会稍微有些散。建议先把原文读顺读熟，再把重点句的气口和重音找准，整体表现会比现在完整很多。";
}

function buildFallbackTail(totalScore: number, mode: LevelMode) {
  if (totalScore >= 85) {
    return mode === "speech"
      ? "后面再把停顿和重音压得更准一些，整段现场感会更强。"
      : "后面再把吐字和停连处理得更细一点，作品感会更足。";
  }

  if (totalScore >= 70) {
    return mode === "speech"
      ? "下一遍把关键词压实、停顿收整，整体力量会更集中。"
      : "下一遍把层次和句尾收音理顺，整体完成度会更高。";
  }

  return mode === "speech"
    ? "先把整段读顺，再去加强重音和语势，效果会更明显。"
    : "先把文本读熟读稳，再去处理情感层次，提升会更快。";
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
