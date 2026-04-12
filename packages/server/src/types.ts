export type LevelMode = "speech" | "recital";

export interface ScoreDimension {
  name: string;
  maxScore: number;
  score: number;
  comment: string;
}

export interface TimedFeedbackItem {
  label: string;
  advice: string;
  timeSeconds?: number;
}

export interface ScoreReport {
  totalScore: number;
  pass: boolean;
  mode: LevelMode;
  summary: string;
  dimensions: ScoreDimension[];
  strengths: string[];
  improvements: string[];
  lineFeedback: TimedFeedbackItem[];
  practiceTip: string;
  transcript?: string;
  accuracyNotes?: string;
  verdict: "pass" | "near_pass" | "retry";
  engine: "gemini" | "mock";
}

export interface LevelConfig {
  id: string;
  title: string;
  mode: LevelMode;
  focus: string;
  passScore: number;
  paragraph: string;
  coachingTip: string;
  promptHint: string;
}

export interface LessonConfig {
  id: string;
  title: string;
  author: string;
  grade: string;
  intro: string;
  fullText: string;
  levels: LevelConfig[];
}

export interface AttemptRecord {
  id: string;
  levelId: string;
  mode: LevelMode;
  status: "recording" | "scored" | "failed";
  createdAt: string;
  updatedAt: string;
  totalScore?: number;
  pass?: boolean;
  transcript?: string;
  liveTranscript?: string;
  audioPath?: string;
  report?: ScoreReport;
}

export interface ProgressRecord {
  levelId: string;
  bestScore: number;
  pass: boolean;
  bestAttemptId?: string;
  updatedAt: string;
}

