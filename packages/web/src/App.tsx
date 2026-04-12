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

  useEffect(() => {
    if (!lesson || selectedLevelId) {
      return;
    }
    const firstPending = lesson.levels.find((item) => !progressMap.get(item.id)?.pass);
    setSelectedLevelId(firstPending?.id ?? lesson.levels[0]?.id ?? null);
  }, [lesson, progressMap, selectedLevelId]);

  async function loadData() {
    try {
      setBusy(true);
      setError(null);
      const [lessonResponse, historyResponse] = await Promise.all([
        fetchLesson(),
        fetchHistory()
      ]);
      setLesson(lessonResponse.lesson);
      setProgress(lessonResponse.progress);
      setHistory(historyResponse.history);
      setGeminiEnabled(lessonResponse.geminiEnabled);
    } catch (loadError) {
      console.error(loadError);
      setError("加载失败，请确认后端服务已经启动。");
    } finally {
      setBusy(false);
    }
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
      setError("启动闯关失败，请稍后重试。");
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
      setError("评分失败，请稍后再试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">八年级下册 · 本地朗诵闯关</p>
          <h1>最后一次讲演</h1>
          <p className="subtitle">
            以原始语音为主评分，按比赛标准即时点评，帮助学生在演讲气势与朗诵层次上逐关突破。
          </p>
        </div>
        <div className="hero-meta">
          <div className="meta-card">
            <span>当前引擎</span>
            <strong>{geminiEnabled ? "Gemini 评分" : "本地模拟评分"}</strong>
          </div>
          <div className="meta-card">
            <span>已通关</span>
            <strong>
              {progress.filter((item) => item.pass).length}/{lesson?.levels.length ?? 0}
            </strong>
          </div>
        </div>
      </header>

      {!geminiEnabled && (
        <section className="banner">
          当前未检测到 `GEMINI_API_KEY`，页面会使用本地模拟评分。填入 API Key 后即可切换为真实 Gemini 语音点评。
        </section>
      )}

      {error && <section className="banner error">{error}</section>}
      {recorder.error && <section className="banner error">{recorder.error}</section>}

      <main className="layout">
        <section className="panel levels">
          <div className="panel-head">
            <h2>关卡地图</h2>
            <button className="ghost-button" onClick={() => void loadData()} disabled={busy}>
              刷新
            </button>
          </div>

          <div className="level-grid">
            {lesson?.levels.map((level, index) => {
              const progressItem = progressMap.get(level.id);
              return (
                <button
                  key={level.id}
                  className={`level-card ${selectedLevelId === level.id ? "selected" : ""}`}
                  onClick={() => setSelectedLevelId(level.id)}
                >
                  <div className="level-card-top">
                    <span className="level-index">{String(index + 1).padStart(2, "0")}</span>
                    <span className={`tag ${level.mode}`}>{level.mode === "speech" ? "演讲" : "朗诵"}</span>
                  </div>
                  <strong>{level.title}</strong>
                  <p>{level.focus}</p>
                  <div className="level-footer">
                    <span>通关线 {level.passScore}</span>
                    <span className={progressItem?.pass ? "pass" : "pending"}>
                      {progressItem?.pass
                        ? `最高 ${progressItem.bestScore}`
                        : progressItem
                          ? `已挑战 ${progressItem.bestScore}`
                          : "待挑战"}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="panel stage">
          {selectedLevel ? (
            <>
              <div className="panel-head">
                <div>
                  <p className="eyebrow">{selectedLevel.mode === "speech" ? "演讲评分关" : "朗诵评分关"}</p>
                  <h2>{selectedLevel.title}</h2>
                </div>
                <div className="stage-actions">
                  {!recorder.isRecording ? (
                    <button className="primary-button" onClick={() => void handleStart(selectedLevel)} disabled={busy}>
                      开始闯关
                    </button>
                  ) : (
                    <button className="danger-button" onClick={() => void handleStop()} disabled={busy}>
                      结束并评分
                    </button>
                  )}
                </div>
              </div>

              <div className="stage-body">
                <div className="text-card">
                  <p className="card-label">本关文本</p>
                  <blockquote>{selectedLevel.paragraph}</blockquote>
                  <div className="hint-list">
                    <span>评分重点：{selectedLevel.focus}</span>
                    <span>示范提示：{selectedLevel.promptHint}</span>
                    <span>教练提醒：{selectedLevel.coachingTip}</span>
                  </div>
                </div>

                <div className="monitor-card">
                  <div className="monitor-row">
                    <span>录音状态</span>
                    <strong>{recorder.statusText}</strong>
                  </div>
                  <div className="monitor-row">
                    <span>已录时长</span>
                    <strong>{formatDuration(recorder.elapsedMs)}</strong>
                  </div>
                  <div className="monitor-row">
                    <span>实时转写</span>
                    <strong>{recorder.transcript ? "持续更新中" : "等待语音输入"}</strong>
                  </div>
                  <div className="transcript-box">
                    {recorder.transcript || "录音开始后，这里会显示 Gemini Live 返回的即时转写辅助。"}
                  </div>
                </div>
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
            <div className="empty-state">正在加载关卡…</div>
          )}
        </section>

        <section className="panel result-panel">
          <div className="panel-head">
            <h2>即时点评</h2>
            <span className="muted">按朗诵比赛评委口吻返回</span>
          </div>
          {currentReport ? (
            <ReportView report={currentReport} />
          ) : (
            <div className="empty-state">
              完成一次闯关后，这里会显示总分、维度分、亮点、改进建议和复练指令。
            </div>
          )}
        </section>

        <section className="panel history-panel">
          <div className="panel-head">
            <h2>本机历史</h2>
            <span className="muted">保留每次闯关记录与录音链接</span>
          </div>
          <div className="history-list">
            {history.length === 0 && <div className="empty-state">还没有历史记录。</div>}
            {history.map((row) => (
              <article key={row.attempt.id} className="history-card">
                <div className="history-head">
                  <strong>{lesson?.levels.find((item) => item.id === row.attempt.levelId)?.title ?? row.attempt.levelId}</strong>
                  <span>{formatTimestamp(row.attempt.createdAt)}</span>
                </div>
                <p>
                  {row.attempt.report
                    ? `${row.attempt.report.totalScore} 分 · ${row.attempt.report.pass ? "通关" : "未通关"}`
                    : "录音中断或尚未评分"}
                </p>
                {row.attempt.report?.summary && <p className="history-summary">{row.attempt.report.summary}</p>}
                {row.attempt.audioPath && (
                  <audio controls preload="none" src={`${PUBLIC_BASE_URL}${row.attempt.audioPath}`}>
                    您的浏览器不支持音频播放。
                  </audio>
                )}
              </article>
            ))}
          </div>
        </section>
      </main>

      {busy && <div className="loading">处理中，请稍候…</div>}
    </div>
  );
}

function ReportView({ report }: { report: ScoreReport }) {
  return (
    <div className="report">
      <div className="report-score">
        <div className={`score-badge ${report.verdict}`}>
          <span>总分</span>
          <strong>{report.totalScore}</strong>
        </div>
        <div>
          <p className="card-label">总评</p>
          <p className="report-summary">{report.summary}</p>
          <p className="report-meta">
            {report.pass ? "已通关" : report.verdict === "near_pass" ? "接近通关，建议复练" : "建议回到当前关重点修正"}
            {" · "}
            {report.engine === "gemini" ? "Gemini 专业评分" : "本地模拟评分"}
          </p>
        </div>
      </div>

      <div className="dimension-list">
        {report.dimensions.map((dimension) => (
          <div key={dimension.name} className="dimension-card">
            <div className="dimension-head">
              <span>{dimension.name}</span>
              <strong>
                {dimension.score}/{dimension.maxScore}
              </strong>
            </div>
            <p>{dimension.comment}</p>
          </div>
        ))}
      </div>

      <div className="report-columns">
        <section>
          <p className="card-label">亮点</p>
          <ul>
            {report.strengths.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
        <section>
          <p className="card-label">改进建议</p>
          <ul>
            {report.improvements.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      </div>

      <section>
        <p className="card-label">逐句指导</p>
        <div className="feedback-list">
          {report.lineFeedback.map((item) => (
            <div key={`${item.label}-${item.advice}`} className="feedback-card">
              <strong>{item.label}</strong>
              <p>{item.advice}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="practice-tip">
        <p className="card-label">复练指令</p>
        <p>{report.practiceTip}</p>
        {report.accuracyNotes && <p className="muted">{report.accuracyNotes}</p>}
      </section>
    </div>
  );
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
const PUBLIC_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

