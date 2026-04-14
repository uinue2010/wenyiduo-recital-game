export type LevelMode = "speech" | "recital";

export interface ScoreReport {
  totalScore: number;
  pass: boolean;
  mode: LevelMode;
  summary: string;
  transcript?: string;
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
