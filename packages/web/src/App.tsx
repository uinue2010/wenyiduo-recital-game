import { useEffect, useMemo, useState } from "react";
import { createAttempt, fetchHistory, fetchLesson, uploadAttemptAudio } from "./api";
import { useRecorder } from "./useRecorder";
import type {
  AttemptRecord,
  HistoryRow,
  LessonConfig,
  LevelConfig,
  ProgressRecord,
  ScoreReport
} from "./types";

const PUBLIC_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export default function App() {
  const recorder = useRecorder();
  const [lesson, setLesson] = useState<LessonConfig | null>(null);
  const [progress, setProgress] = useState<ProgressRecord[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [selectedLevelId, setSelectedLevelId] = useState<string | null>(null);
  const [activeAttempt, setActiveAttempt] = useState<AttemptRecord | null>(null);
  const [currentReport, setCurrentReport] = useState<ScoreReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [geminiEnabled, setGeminiEnabled] = useState(true);

  useEffect(() => {
    void loadData();
  }, []);

  const selectedLevel = useMemo(() => {
    return lesson?.levels.find((item) => item.id === selectedLevelId) ?? null;
  }, [lesson, selectedLevelId]);

  const progressMap = useMemo(() => {
    return new Map(progress.map((item) => [item.levelId, item]));
  }, [progress]);

  const completedCount = progress.filter((item) => item.pass).length;
  const selectedProgress = selectedLevel ? progressMap.get(selectedLevel.id) : undefined;

  useEffect(() => {
    if (!lesson || selectedLevelId) {
      return;
    }
    const firstPending = lesson.levels.find((item) => !progressMap.get(item.id)?.pass);
    setSelectedLevelId(firstPending?.id ?? lesson.levels[0]?.id ?? null);
  }, [lesson, progressMap, selectedLevelId]);

  async function loadData() {
    setBusy(true);
    setError(null);
    setWarning(null);

    const [lessonResult, historyResult] = await Promise.allSettled([
      fetchLesson(),
      fetchHistory()
    ]);

    if (lessonResult.status === "fulfilled") {
      setLesson(lessonResult.value.lesson);
      setProgress(lessonResult.value.progress);
      setGeminiEnabled(lessonResult.value.geminiEnabled);
    } else {
      console.error(lessonResult.reason);
      setError("关卡加载失败，请稍后刷新页面。");
    }

    if (historyResult.status === "fulfilled") {
      setHistory(historyResult.value.history);
    } else {
      console.error(historyResult.reason);
      setWarning("历史记录暂时未同步成功，但当前闯关仍可正常使用。");
    }

    setBusy(false);
  }

  async function handleStart(level: LevelConfig) {
    try {
      setBusy(true);
      setError(null);
      setCurrentReport(null);
      recorder.reset();
      const response = await createAttempt(level.id, level.mode);
      setActiveAttempt(response.attempt);
      await recorder.start({
        attemptId: response.attempt.id,
        levelId: level.id
      });
    } catch (startError) {
      console.error(startError);
      setError("录音启动失败，请检查浏览器麦克风权限。");
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    if (!activeAttempt) {
      return;
    }

    try {
      setBusy(true);
      const result = await recorder.stop();
      if (!result) {
        return;
      }

      const response = await uploadAttemptAudio({
        attemptId: activeAttempt.id,
        audioBlob: result.audioBlob,
        liveTranscript: result.transcript,
        durationMs: result.durationMs
      });
      setCurrentReport(response.attempt.report ?? null);
      setActiveAttempt(response.attempt);
      await loadData();
    } catch (stopError) {
      console.error(stopError);
      setError("评分返回失败，请稍后再试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <div className="page">
        <header className="hero">
          <div className="hero-copy">
            <p className="hero-caption">八年级下册 · 闻一多</p>
            <h1>最后一次讲演</h1>
            <p className="hero-summary">
              围绕课文段落做逐关朗读。系统根据原始语音给出即时评分、文本准确度提示和更接近比赛评委口吻的专业点评。
            </p>
          </div>

          <div className="hero-stats">
            <StatCard label="当前引擎" value={geminiEnabled ? "Gemini 评分" : "本地模拟评分"} />
            <StatCard
              label="通关进度"
              value={`${completedCount}/${lesson?.levels.length ?? 0}`}
            />
          </div>
        </header>

        {!geminiEnabled && (
          <section className="notice">
            当前没有检测到 `GEMINI_API_KEY`，系统会自动使用本地模拟评分。
          </section>
        )}
        {warning && <section className="notice notice-soft">{warning}</section>}
        {error && <section className="notice notice-danger">{error}</section>}
        {recorder.error && <section className="notice notice-danger">{recorder.error}</section>}

        <main className="layout">
          <aside className="sidebar card">
            <div className="block-head">
              <div>
                <p className="eyebrow">关卡</p>
                <h2>课程章节</h2>
              </div>
              <button className="subtle-button" onClick={() => void loadData()} disabled={busy}>
                刷新
              </button>
            </div>

            <div className="level-list">
              {lesson?.levels.map((level, index) => {
                const progressItem = progressMap.get(level.id);
                const selected = selectedLevelId === level.id;
                return (
                  <button
                    key={level.id}
                    className={`level-item ${selected ? "selected" : ""}`}
                    onClick={() => setSelectedLevelId(level.id)}
                  >
                    <div className="level-item-top">
                      <span className="level-order">{String(index + 1).padStart(2, "0")}</span>
                      <span className={`mode-tag ${level.mode}`}>
                        {level.mode === "speech" ? "演讲" : "朗诵"}
                      </span>
                    </div>
                    <strong>{level.title}</strong>
                    <p>{level.focus}</p>
                    <div className="level-item-meta">
                      <span>通关线 {level.passScore}</span>
                      <span className={progressItem?.pass ? "ok" : "muted"}>
                        {progressItem?.pass
                          ? `最高 ${progressItem.bestScore}`
                          : progressItem
                            ? `已挑战 ${progressItem.bestScore}`
                            : "未开始"}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="main-column">
            <section className="card lesson-card">
              {selectedLevel ? (
                <>
                  <div className="block-head lesson-head">
                    <div>
                      <p className="eyebrow">
                        {selectedLevel.mode === "speech" ? "演讲评分关" : "朗诵评分关"}
                      </p>
                      <h2>{selectedLevel.title}</h2>
                    </div>
                    <div className="lesson-status">
                      <span>{selectedProgress?.pass ? `本关最高 ${selectedProgress.bestScore}` : "本关尚未通关"}</span>
                    </div>
                  </div>

                  <div className="lesson-grid">
                    <article className="reading-card">
                      <div className="reading-meta">
                        <span>本关文本</span>
                        <span>建议先默读一遍再开始</span>
                      </div>
                      <blockquote>{selectedLevel.paragraph}</blockquote>
                      <div className="notes-grid">
                        <NoteItem title="评分重点" value={selectedLevel.focus} />
                        <NoteItem title="示范提示" value={selectedLevel.promptHint} />
                        <NoteItem title="教练提醒" value={selectedLevel.coachingTip} />
                      </div>
                    </article>

                    <aside className="record-card">
                      <div className="record-actions">
                        <div>
                          <p className="eyebrow">录音控制</p>
                          <h3>开始朗读</h3>
                        </div>
                        {!recorder.isRecording ? (
                          <button
                            className="primary-button"
                            onClick={() => void handleStart(selectedLevel)}
                            disabled={busy}
                          >
                            开始闯关
                          </button>
                        ) : (
                          <button
                            className="danger-button"
                            onClick={() => void handleStop()}
                            disabled={busy}
                          >
                            结束并评分
                          </button>
                        )}
                      </div>

                      <div className="record-metrics">
                        <StatLine label="录音状态" value={recorder.statusText} />
                        <StatLine label="已录时长" value={formatDuration(recorder.elapsedMs)} />
                        <StatLine
                          label="当前阶段"
                          value={recorder.isRecording ? "正在聆听" : "等待开始"}
                        />
                      </div>

                      <div className="transcript-card">
                        <div className="reading-meta">
                          <span>即时转写</span>
                          <span>用于辅助对齐文本</span>
                        </div>
                        <p>
                          {recorder.transcript ||
                            "开始录音后，这里会显示 Gemini Live 的即时转写结果。"}
                        </p>
                      </div>
                    </aside>
                  </div>

                  <div className="rubric-grid">
                    {selectedLevel.rubric.map((item) => (
                      <div key={item.name} className="rubric-card">
                        <span>{item.name}</span>
                        <strong>{item.maxScore} 分</strong>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="empty-state">正在加载当前关卡…</div>
              )}
            </section>

            <section className="card result-card">
              <div className="block-head">
                <div>
                  <p className="eyebrow">点评</p>
                  <h2>即时结果</h2>
                </div>
              </div>
              {currentReport ? (
                <ReportView report={currentReport} />
              ) : (
                <div className="empty-state">
                  完成一次闯关后，这里会显示总分、维度分、亮点、改进建议和复练指令。
                </div>
              )}
            </section>
          </section>

          <section className="card history-card">
            <div className="block-head">
              <div>
                <p className="eyebrow">历史记录</p>
                <h2>本机存档</h2>
              </div>
              <span className="history-hint">保留每次闯关记录与录音回放</span>
            </div>

            <div className="history-list">
              {history.length === 0 && <div className="empty-state">还没有历史记录。</div>}
              {history.map((row) => (
                <article key={row.attempt.id} className="history-entry">
                  <div className="history-time">{formatTimestamp(row.attempt.createdAt)}</div>
                  <div className="history-content">
                    <div className="history-top">
                      <strong>
                        {lesson?.levels.find((item) => item.id === row.attempt.levelId)?.title ??
                          row.attempt.levelId}
                      </strong>
                      <span className="history-badge">
                        {row.attempt.report
                          ? `${row.attempt.report.totalScore} 分 · ${verdictLabel(
                              row.attempt.report.verdict
                            )}`
                          : "未评分"}
                      </span>
                    </div>
                    {row.attempt.report?.summary && (
                      <p className="history-summary">{row.attempt.report.summary}</p>
                    )}
                    {row.attempt.audioPath && (
                      <audio
                        controls
                        preload="none"
                        src={`${PUBLIC_BASE_URL}${row.attempt.audioPath}`}
                      >
                        您的浏览器不支持音频播放。
                      </audio>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        </main>
      </div>

      {busy && <div className="loading-toast">处理中，请稍候…</div>}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function NoteItem({ title, value }: { title: string; value: string }) {
  return (
    <div className="note-item">
      <span>{title}</span>
      <p>{value}</p>
    </div>
  );
}

function StatLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ReportView({ report }: { report: ScoreReport }) {
  return (
    <div className="report-shell">
      <div className="report-header">
        <div className={`score-panel ${report.verdict}`}>
          <span>总分</span>
          <strong>{report.totalScore}</strong>
        </div>
        <div className="report-main">
          <div className="report-topline">
            <span>{verdictLabel(report.verdict)}</span>
            <span>{report.engine === "gemini" ? "Gemini 专业评分" : "本地模拟评分"}</span>
          </div>
          <p className="report-summary">{report.summary}</p>
          <p className="report-subtitle">
            {report.pass
              ? "本关已经达到通关要求，可以继续挑战下一关。"
              : report.verdict === "near_pass"
                ? "已经接近通关，建议按重点句再复练一次。"
                : "建议先留在当前关，把重音、停顿和文本完整度补齐。"}
          </p>
        </div>
      </div>

      <div className="dimension-grid">
        {report.dimensions.map((dimension) => (
          <div key={dimension.name} className="dimension-card">
            <div className="dimension-top">
              <span>{dimension.name}</span>
              <strong>
                {dimension.score}/{dimension.maxScore}
              </strong>
            </div>
            <p>{dimension.comment}</p>
          </div>
        ))}
      </div>

      <div className="insight-grid">
        <section className="insight-card">
          <h3>亮点</h3>
          <ul>
            {report.strengths.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
        <section className="insight-card">
          <h3>改进建议</h3>
          <ul>
            {report.improvements.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      </div>

      <section className="feedback-section">
        <h3>逐句指导</h3>
        <div className="feedback-grid">
          {report.lineFeedback.map((item) => (
            <div key={`${item.label}-${item.advice}`} className="feedback-card">
              <strong>{item.label}</strong>
              <p>{item.advice}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="practice-card">
        <h3>复练指令</h3>
        <p>{report.practiceTip}</p>
        {report.accuracyNotes && <span>{report.accuracyNotes}</span>}
      </section>
    </div>
  );
}

function verdictLabel(verdict: ScoreReport["verdict"]) {
  if (verdict === "pass") {
    return "已通关";
  }
  if (verdict === "near_pass") {
    return "接近通关";
  }
  return "建议复练";
}

function formatDuration(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
