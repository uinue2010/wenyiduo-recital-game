import type {
  AttemptRecord,
  HistoryRow,
  LessonConfig,
  LevelMode,
  ProgressRecord
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
const NORMALIZED_API_BASE = API_BASE === "/" ? "" : API_BASE;

export async function fetchLesson() {
  const response = await fetch(`${NORMALIZED_API_BASE}/api/lesson`);
  if (!response.ok) {
    throw new Error("获取课文关卡失败。");
  }
  return (await response.json()) as {
    lesson: LessonConfig;
    progress: ProgressRecord[];
    geminiEnabled: boolean;
  };
}

export async function createAttempt(levelId: string, mode: LevelMode) {
  const response = await fetch(`${NORMALIZED_API_BASE}/api/attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ levelId, mode })
  });
  if (!response.ok) {
    throw new Error("创建闯关记录失败。");
  }
  return (await response.json()) as { attempt: AttemptRecord };
}

export async function uploadAttemptAudio(input: {
  attemptId: string;
  audioBlob: Blob;
  liveTranscript: string;
  durationMs: number;
}) {
  const formData = new FormData();
  formData.append("audio", input.audioBlob, "attempt.wav");
  formData.append("liveTranscript", input.liveTranscript);
  formData.append("transcriptHint", input.liveTranscript);
  formData.append("durationMs", String(input.durationMs));

  const response = await fetch(`${NORMALIZED_API_BASE}/api/attempts/${input.attemptId}/audio`, {
    method: "POST",
    body: formData
  });
  if (!response.ok) {
    throw new Error("上传音频失败。");
  }
  return (await response.json()) as { attempt: AttemptRecord };
}

export async function fetchHistory() {
  const response = await fetch(`${NORMALIZED_API_BASE}/api/history`);
  if (!response.ok) {
    throw new Error("获取历史记录失败。");
  }
  return (await response.json()) as { history: HistoryRow[] };
}

export function getApiBaseUrl() {
  if (NORMALIZED_API_BASE) {
    return NORMALIZED_API_BASE;
  }
  return window.location.origin;
}
