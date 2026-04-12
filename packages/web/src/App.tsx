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
  const selectedIndex = selectedLevel
    ? (lesson?.levels.findIndex((item) => item.id === selectedLevel.id) ?? -1) + 1
    : 0;

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
      setError("关卡加载失败，请稍后刷新页面再试。");
    }

    if (historyResult.status === "fulfilled") {
      setHistory(historyResult.value.history);
    } else {
      console.error(historyResult.reason);
      setWarning("历史记录暂时没有同步成功，但不影响当前闯关。");
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
      setError("录音启动失败，请确认浏览器麦克风权限已经允许。");
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
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />
      <div className="paper-frame">
        <header className="masthead">
          <div className="masthead-copy">
            <p className="kicker">八年级下册 · 闻一多专题闯关</p>
            <h1>最后一次讲演</h1>
            <p className="deck">
              按比赛评审逻辑即时打分，让学生在演讲气势、停连节奏与情感层次上逐关提升，
              读完就知道自己哪里有力量，哪里还欠火候。
            </p>
            <div className="headline-strip">
              <span>原始语音主评</span>
              <span>实时转写辅助</span>
              <span>专业评委口吻</span>
            </div>
          </div>

          <aside className="masthead-aside">
            <div className="hero-stat-card">
              <span>当前引擎</span>
              <strong>{geminiEnabled ? "Gemini 语音评分" : "本地模拟评分"}</strong>
            </div>
            <div className="hero-stat-card">
              <span>关卡进度</span>
              <strong>
                {completedCount}/{lesson?.levels.length ?? 0}
              </strong>
            </div>
            <div className="hero-quote-card">
              <p className="quote-mark">“</p>
              <p>我们的光明，就在我们的前面。</p>
              <span>课文收束句 · 适合作为整篇朗读的情感高点</span>
            </div>
          </aside>
        </header>

        {!geminiEnabled && (
          <section className="message-bar">
            当前服务端没有读到 `GEMINI_API_KEY`，会自动回退到本地模拟评分。
          </section>
        )}

        {warning && <section className="message-bar subtle">{warning}</section>}
        {error && <section className="message-bar danger">{error}</section>}
        {recorder.error && <section className="message-bar danger">{recorder.error}</section>}

        <main className="editorial-grid">
          <aside className="panel-surface rail-panel">
            <div className="section-heading">
              <p className="section-label">Stage Map</p>
              <h2>关卡地图</h2>
            </div>

            <div className="rail-summary">
              <span>从怒斥暗杀到宣告胜利，按情绪推进完成整篇训练。</span>
              <button className="ghost-button" onClick={() => void loadData()} disabled={busy}>
                刷新
              </button>
            </div>

            <div className="rail-list">
              {lesson?.levels.map((level, index) => {
                const progressItem = progressMap.get(level.id);
                const isSelected = selectedLevelId === level.id;
                return (
                  <button
                    key={level.id}
                    className={`rail-card ${isSelected ? "selected" : ""}`}
                    onClick={() => setSelectedLevelId(level.id)}
                  >
                    <div className="rail-card-top">
                      <span className="rail-index">{String(index + 1).padStart(2, "0")}</span>
                      <span className={`mode-pill ${level.mode}`}>
                        {level.mode === "speech" ? "演讲" : "朗诵"}
                      </span>
                    </div>
                    <strong>{level.title}</strong>
                    <p>{level.focus}</p>
                    <div className="rail-card-meta">
                      <span>通关线 {level.passScore}</span>
                      <span className={progressItem?.pass ? "state-pass" : "state-pending"}>
                        {progressItem?.pass
                          ? `已通关 ${progressItem.bestScore}`
                          : progressItem
                            ? `最高 ${progressItem.bestScore}`
                            : "待挑战"}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="content-column">
            <section className="panel-surface stage-panel">
              {selectedLevel ? (
                <>
                  <div className="section-heading stage-heading">
                    <div>
                      <p className="section-label">
                        Chapter {String(selectedIndex).padStart(2, "0")}
                      </p>
                      <h2>{selectedLevel.title}</h2>
                    </div>

                    <div className="stage-heading-meta">
                      <span className={`mode-pill ${selectedLevel.mode}`}>
                        {selectedLevel.mode === "speech" ? "演讲评分关" : "朗诵评分关"}
                      </span>
                      <span className="quiet-meta">
                        {selectedProgress?.pass
                          ? `本关最高 ${selectedProgress.bestScore}`
                          : "本关尚未通关"}
                      </span>
                    </div>
                  </div>

                  <div className="stage-grid">
                    <article className="passage-sheet">
                      <div className="sheet-topline">
                        <span>本关文本</span>
                        <span>重点看气势、层次和准确度</span>
                      </div>
                      <blockquote>{selectedLevel.paragraph}</blockquote>
                      <div className="annotation-grid">
                        <div>
                          <span>评分重点</span>
                          <p>{selectedLevel.focus}</p>
                        </div>
                        <div>
                          <span>示范提示</span>
                          <p>{selectedLevel.promptHint}</p>
                        </div>
                        <div>
                          <span>教练提醒</span>
                          <p>{selectedLevel.coachingTip}</p>
                        </div>
                      </div>
                    </article>

                    <aside className="command-panel">
                      <div className="command-head">
                        <p className="section-label">Live Booth</p>
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

                      <div className="command-stats">
                        <MetricCard label="录音状态" value={recorder.statusText} />
                        <MetricCard label="已录时长" value={formatDuration(recorder.elapsedMs)} />
                        <MetricCard
                          label="当前阶段"
                          value={recorder.isRecording ? "正在聆听" : "等待开始"}
                        />
                      </div>

                      <div className="transcript-panel">
                        <div className="sheet-topline">
                          <span>即时转写</span>
                          <span>Gemini Live 辅助对齐</span>
                        </div>
                        <p>
                          {recorder.transcript ||
                            "开始录音后，这里会同步出现即时转写，用来辅助判断是否漏读、跳句或气口混乱。"}
                        </p>
                      </div>
                    </aside>
                  </div>

                  <div className="rubric-row">
                    {selectedLevel.rubric.map((item) => (
                      <div key={item.name} className="rubric-tile">
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

            <section className="panel-surface critique-panel">
              <div className="section-heading">
                <p className="section-label">Judging Notes</p>
                <h2>即时点评</h2>
              </div>
              {currentReport ? (
                <ReportView report={currentReport} />
              ) : (
                <div className="empty-state report-empty">
                  完成一次闯关后，这里会按朗诵比赛评委口吻返回总评、维度分、亮点、改进建议和复练指令。
                </div>
              )}
            </section>
          </section>

          <section className="panel-surface archive-panel">
            <div className="section-heading archive-heading">
              <div>
                <p className="section-label">Archive</p>
                <h2>本机历史</h2>
              </div>
              <span className="quiet-meta">保留每次闯关记录与录音回放</span>
            </div>

            <div className="history-timeline">
              {history.length === 0 && <div className="empty-state">还没有历史记录。</div>}
              {history.map((row) => (
                <article key={row.attempt.id} className="history-item">
                  <div className="history-timestamp">{formatTimestamp(row.attempt.createdAt)}</div>
                  <div className="history-body">
                    <div className="history-headline">
                      <strong>
                        {lesson?.levels.find((item) => item.id === row.attempt.levelId)?.title ??
                          row.attempt.levelId}
                      </strong>
                      <span className="history-score">
                        {row.attempt.report
                          ? `${row.attempt.report.totalScore} 分 · ${verdictLabel(
                              row.attempt.report.verdict
                            )}`
                          : "录音中断或尚未评分"}
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

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ReportView({ report }: { report: ScoreReport }) {
  return (
    <div className="report-shell">
      <div className="report-banner">
        <div className={`score-orb ${report.verdict}`}>
          <span>总分</span>
          <strong>{report.totalScore}</strong>
        </div>

        <div className="report-intro">
          <div className="report-topline">
            <span>{verdictLabel(report.verdict)}</span>
            <span>{report.engine === "gemini" ? "Gemini 专业评分" : "本地模拟评分"}</span>
          </div>
          <p className="report-summary">{report.summary}</p>
          <p className="report-note">
            {report.pass
              ? "本关已达通关线，可以继续向下一关推进。"
              : report.verdict === "near_pass"
                ? "已经接近通关，建议按点评中的重点句再复练一遍。"
                : "建议先留在当前关，重点补足重音、停顿和文本完整度。"}
          </p>
        </div>
      </div>

      <div className="dimension-board">
        {report.dimensions.map((dimension) => (
          <div key={dimension.name} className="dimension-tile">
            <div className="dimension-tile-head">
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
          <div className="sheet-topline">
            <span>亮点</span>
            <span>值得保留的表达</span>
          </div>
          <ul>
            {report.strengths.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="insight-card warning-card">
          <div className="sheet-topline">
            <span>改进建议</span>
            <span>下一次要刻意修正</span>
          </div>
          <ul>
            {report.improvements.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      </div>

      <section className="feedback-panel">
        <div className="sheet-topline">
          <span>逐句指导</span>
          <span>按比赛点评方式给出纠偏</span>
        </div>
        <div className="feedback-grid">
          {report.lineFeedback.map((item) => (
            <div key={`${item.label}-${item.advice}`} className="feedback-note">
              <strong>{item.label}</strong>
              <p>{item.advice}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="practice-banner">
        <p className="section-label">Practice Cue</p>
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
