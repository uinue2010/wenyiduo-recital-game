import { useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
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
  const lastSpokenSummaryRef = useRef("");
  const speechRetryTimerRef = useRef<number | null>(null);
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

  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel();
      clearSpeechRetryTimer(speechRetryTimerRef);
    };
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

  useEffect(() => {
    if (!currentReport?.summary) {
      return;
    }
    if (lastSpokenSummaryRef.current === currentReport.summary) {
      return;
    }
    lastSpokenSummaryRef.current = currentReport.summary;
    autoSpeakSummary(currentReport.summary, speechRetryTimerRef);
  }, [currentReport]);

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
      lastSpokenSummaryRef.current = "";
      window.speechSynthesis?.cancel();
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
      if (response.attempt.report?.summary) {
        lastSpokenSummaryRef.current = response.attempt.report.summary;
        autoSpeakSummary(response.attempt.report.summary, speechRetryTimerRef);
      }
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
      <div className="page-frame">
        <header className="masthead">
          <div className="masthead-copy">
            <p className="overline">
              {lesson?.grade ?? "八年级下册"} · {lesson?.author ?? "闻一多"}
            </p>
            <h1>{lesson?.title ?? "最后一次讲演"}</h1>
            <p className="lede">
              {lesson?.intro ??
                "围绕课文段落逐关朗读，完成演讲与朗诵两类训练，读完即可听到简短语音总评。"}
            </p>
          </div>

          <div className="masthead-meta">
            <MetaLine label="评分方式" value={geminiEnabled ? "Gemini 专业评分" : "本地模拟评分"} />
            <MetaLine
              label="通关情况"
              value={`${completedCount}/${lesson?.levels.length ?? 0} 段已完成`}
            />
          </div>
        </header>

        {!geminiEnabled && (
          <section className="notice">
            当前未检测到 `GEMINI_API_KEY`，系统会自动使用本地模拟评分。
          </section>
        )}
        {warning && <section className="notice notice-soft">{warning}</section>}
        {error && <section className="notice notice-danger">{error}</section>}
        {recorder.error && <section className="notice notice-danger">{recorder.error}</section>}

        <main className="reading-layout">
          <aside className="paper chapter-rail">
            <div className="section-head">
              <div>
                <p className="section-kicker">目录</p>
                <h2>课文闯关</h2>
              </div>
              <button className="quiet-button" onClick={() => void loadData()} disabled={busy}>
                刷新
              </button>
            </div>

            <div className="chapter-list">
              {lesson?.levels.map((level, index) => {
                const progressItem = progressMap.get(level.id);
                const selected = selectedLevelId === level.id;
                return (
                  <button
                    key={level.id}
                    className={`chapter-item ${selected ? "selected" : ""}`}
                    onClick={() => setSelectedLevelId(level.id)}
                  >
                    <div className="chapter-top">
                      <span className="chapter-order">{String(index + 1).padStart(2, "0")}</span>
                      <span className="chapter-mode">
                        {level.mode === "speech" ? "演讲关" : "朗诵关"}
                      </span>
                    </div>
                    <strong>{level.title}</strong>
                    <p>{level.focus}</p>
                    <span className={`chapter-progress ${progressItem?.pass ? "pass" : ""}`}>
                      {progressItem?.pass
                        ? `已通关 · 最高 ${progressItem.bestScore}`
                        : progressItem
                          ? `已练习 · 最高 ${progressItem.bestScore}`
                          : `通关线 ${level.passScore}`}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="rail-footnote">
              <p>建议从上到下顺序练习，先把文本读完整，再去处理重音与节奏。</p>
            </div>
          </aside>

          <section className="content-column">
            {selectedLevel ? (
              <>
                <section className="paper passage-panel">
                  <div className="section-head section-head-wide">
                    <div>
                      <p className="section-kicker">
                        {selectedLevel.mode === "speech" ? "演讲训练" : "朗诵训练"}
                      </p>
                      <h2>{selectedLevel.title}</h2>
                      <p className="section-note">
                        本关重点：{selectedLevel.focus}
                      </p>
                    </div>

                    <div className="status-chip">
                      {selectedProgress?.pass
                        ? `本关已通关 · 最高 ${selectedProgress.bestScore} 分`
                        : `通关线 ${selectedLevel.passScore} 分`}
                    </div>
                  </div>

                  <div className="passage-body">
                    <p className="passage-text">{selectedLevel.paragraph}</p>
                  </div>

                  <div className="annotation-grid">
                    <InfoCard title="评分重点" value={selectedLevel.focus} />
                    <InfoCard title="示范提示" value={selectedLevel.promptHint} />
                    <InfoCard title="练习提醒" value={selectedLevel.coachingTip} />
                  </div>
                </section>

                <section className="paper practice-panel">
                  <div className="practice-copy">
                    <p className="section-kicker">开始练习</p>
                    <h2>{recorder.isRecording ? "请保持稳定语速完成本段朗读" : "准备好后开始本关朗读"}</h2>
                    <p className="section-note">
                      先完整读完，再看评分。不要一边读一边抢着纠正，整体气息和完整度更重要。
                    </p>
                  </div>

                  <div className="practice-actions">
                    {!recorder.isRecording ? (
                      <button
                        className="primary-button"
                        onClick={() => void handleStart(selectedLevel)}
                        disabled={busy}
                      >
                        开始朗读
                      </button>
                    ) : (
                      <button
                        className="primary-button primary-button-stop"
                        onClick={() => void handleStop()}
                        disabled={busy}
                      >
                        结束并评分
                      </button>
                    )}

                    <div className="practice-stats">
                      <MetricCard label="录音状态" value={recorder.statusText} />
                      <MetricCard label="已录时长" value={formatDuration(recorder.elapsedMs)} />
                      <MetricCard
                        label="当前阶段"
                        value={recorder.isRecording ? "系统正在聆听" : "等待开始"}
                      />
                    </div>
                  </div>

                  <div className="transcript-panel">
                    <div className="transcript-head">
                      <span>听读记录</span>
                      <span>用于辅助文本对齐</span>
                    </div>
                    <p>
                      {recorder.transcript ||
                        "开始录音后，这里会显示实时转写内容，便于发现漏读、跳读和停顿不稳的地方。"}
                    </p>
                  </div>
                </section>

                <section className="paper rubric-panel">
                  <div className="section-head section-head-wide rubric-head">
                    <div>
                      <p className="section-kicker">评分标准</p>
                      <h2>本关会这样给分</h2>
                    </div>
                  </div>
                  <div className="rubric-list">
                    {selectedLevel.rubric.map((item) => (
                      <div key={item.name} className="rubric-row">
                        <span>{item.name}</span>
                        <strong>{item.maxScore} 分</strong>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="paper result-panel">
                  <div className="section-head section-head-wide">
                    <div>
                      <p className="section-kicker">评语</p>
                      <h2>本次点评</h2>
                    </div>
                    {currentReport && (
                      <span className="result-engine">
                        {currentReport.engine === "gemini" ? "Gemini 评审" : "本地模拟评分"}
                      </span>
                    )}
                  </div>

                  {currentReport ? (
                    <ReportView report={currentReport} />
                  ) : (
                    <div className="placeholder-copy">
                      完成一次朗读后，这里只会播放一段简短语音总评，不再展开长篇文字点评。
                    </div>
                  )}
                </section>

                <section className="paper history-panel">
                  <div className="section-head">
                    <div>
                      <p className="section-kicker">存档</p>
                      <h2>练习记录</h2>
                    </div>
                    <span className="section-caption">保留本机成绩与录音回放</span>
                  </div>

                  <div className="history-list">
                    {history.length === 0 && <div className="placeholder-copy">还没有历史记录。</div>}
                    {history.map((row) => (
                      <article key={row.attempt.id} className="history-entry">
                        <div className="history-meta">
                          <span>{formatTimestamp(row.attempt.createdAt)}</span>
                          <span>
                            {lesson?.levels.find((item) => item.id === row.attempt.levelId)?.title ??
                              row.attempt.levelId}
                          </span>
                        </div>
                        <div className="history-body">
                          <div className="history-scoreline">
                            <strong>
                              {row.attempt.report
                                ? `${row.attempt.report.totalScore} 分`
                                : "等待评分"}
                            </strong>
                            <span>
                              {row.attempt.report
                                ? verdictLabel(row.attempt.report.verdict)
                                : "未完成"}
                            </span>
                          </div>
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
              </>
            ) : (
              <section className="paper placeholder-panel">
                正在准备课文内容，请稍候。
              </section>
            )}
          </section>
        </main>
      </div>

      {busy && <div className="loading-pill">处理中，请稍候…</div>}
    </div>
  );
}

function MetaLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="meta-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function InfoCard({ title, value }: { title: string; value: string }) {
  return (
    <article className="info-card">
      <span>{title}</span>
      <p>{value}</p>
    </article>
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
    <div className="report-layout">
      <div className="report-summary-block">
        <div className={`score-badge ${report.verdict}`}>
          <span>总分</span>
          <strong>{report.totalScore}</strong>
        </div>
        <div className="teacher-note">
          <div className="teacher-note-top">
            <span>{verdictLabel(report.verdict)}</span>
            <span>{report.pass ? "评分完成后自动播报" : "总评已自动播报"}</span>
          </div>
          <p className="voice-note">点评已压缩为 150 字以内的总评，分数出现后会直接自动播放。</p>
        </div>
      </div>
    </div>
  );
}

function autoSpeakSummary(text: string, retryTimerRef: MutableRefObject<number | null>) {
  clearSpeechRetryTimer(retryTimerRef);
  const hasStarted = speakSummary(text);

  retryTimerRef.current = window.setTimeout(() => {
    if (!hasStarted()) {
      speakSummary(text);
    }
    clearSpeechRetryTimer(retryTimerRef);
  }, 900);
}

function speakSummary(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return () => false;
  }

  const summary = text.trim();
  if (!summary) {
    return () => false;
  }

  const synth = window.speechSynthesis;
  synth.cancel();
  synth.resume();
  synth.getVoices();
  let started = false;

  const utterance = new SpeechSynthesisUtterance(summary);
  utterance.lang = "zh-CN";
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.volume = 1;
  utterance.onstart = () => {
    started = true;
  };

  const chineseVoice =
    synth
      .getVoices()
      .find((voice) => voice.lang.toLowerCase().includes("zh") || /xiaoxiao|yunxi|xiaoyi/i.test(voice.name)) ??
    null;
  if (chineseVoice) {
    utterance.voice = chineseVoice;
  }

  synth.speak(utterance);
  return () => started;
}

function clearSpeechRetryTimer(timerRef: MutableRefObject<number | null>) {
  if (timerRef.current != null) {
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }
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
