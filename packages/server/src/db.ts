import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AttemptRecord, ProgressRecord, ScoreReport } from "./types.js";

export interface HistoryRow {
  attempt: AttemptRecord;
  progress?: ProgressRecord;
}

export class AppDatabase {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        level_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        total_score REAL,
        pass INTEGER,
        transcript TEXT,
        live_transcript TEXT,
        audio_path TEXT,
        duration_ms INTEGER,
        report_json TEXT
      );

      CREATE TABLE IF NOT EXISTS progress (
        level_id TEXT PRIMARY KEY,
        best_score REAL NOT NULL,
        pass INTEGER NOT NULL,
        best_attempt_id TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }

  createAttempt(record: AttemptRecord) {
    this.db
      .prepare(`
        INSERT INTO attempts (
          id, level_id, mode, status, created_at, updated_at, total_score,
          pass, transcript, live_transcript, audio_path, duration_ms, report_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.levelId,
        record.mode,
        record.status,
        record.createdAt,
        record.updatedAt,
        record.totalScore ?? null,
        record.pass == null ? null : Number(record.pass),
        record.transcript ?? null,
        record.liveTranscript ?? null,
        record.audioPath ?? null,
        null,
        record.report ? JSON.stringify(record.report) : null
      );
  }

  updateAttemptLiveTranscript(id: string, liveTranscript: string) {
    this.db
      .prepare(
        `UPDATE attempts SET live_transcript = ?, updated_at = ? WHERE id = ?`
      )
      .run(liveTranscript, new Date().toISOString(), id);
  }

  saveAttemptAudio(id: string, audioPath: string, durationMs: number) {
    this.db
      .prepare(
        `UPDATE attempts SET audio_path = ?, duration_ms = ?, updated_at = ? WHERE id = ?`
      )
      .run(audioPath, durationMs, new Date().toISOString(), id);
  }

  saveScore(
    id: string,
    payload: {
      status: AttemptRecord["status"];
      score: ScoreReport;
      transcript?: string;
      liveTranscript?: string;
    }
  ) {
    this.db
      .prepare(`
        UPDATE attempts
        SET status = ?, total_score = ?, pass = ?, transcript = ?, live_transcript = ?, report_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        payload.status,
        payload.score.totalScore,
        Number(payload.score.pass),
        payload.transcript ?? null,
        payload.liveTranscript ?? null,
        JSON.stringify(payload.score),
        new Date().toISOString(),
        id
      );

    const attempt = this.getAttempt(id);
    if (!attempt?.report) {
      return;
    }

    const currentProgress = this.getProgress(attempt.levelId);
    if (!currentProgress || attempt.report.totalScore >= currentProgress.bestScore) {
      const nextProgress: ProgressRecord = {
        levelId: attempt.levelId,
        bestScore: attempt.report.totalScore,
        pass: attempt.report.pass,
        bestAttemptId: attempt.id,
        updatedAt: new Date().toISOString()
      };

      this.db
        .prepare(`
          INSERT INTO progress (level_id, best_score, pass, best_attempt_id, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(level_id) DO UPDATE SET
            best_score = excluded.best_score,
            pass = excluded.pass,
            best_attempt_id = excluded.best_attempt_id,
            updated_at = excluded.updated_at
        `)
        .run(
          nextProgress.levelId,
          nextProgress.bestScore,
          Number(nextProgress.pass),
          nextProgress.bestAttemptId ?? null,
          nextProgress.updatedAt
        );
    }
  }

  getAttempt(id: string): AttemptRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM attempts WHERE id = ? LIMIT 1`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapAttempt(row) : null;
  }

  getProgress(levelId: string): ProgressRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM progress WHERE level_id = ? LIMIT 1`)
      .get(levelId) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return {
      levelId: String(row.level_id),
      bestScore: Number(row.best_score),
      pass: Boolean(row.pass),
      bestAttemptId: row.best_attempt_id ? String(row.best_attempt_id) : undefined,
      updatedAt: String(row.updated_at)
    };
  }

  getHistory(): HistoryRow[] {
    const rows = this.db
      .prepare(`
        SELECT a.*, p.best_score, p.pass AS progress_pass, p.best_attempt_id, p.updated_at AS progress_updated_at
        FROM attempts a
        LEFT JOIN progress p ON p.level_id = a.level_id
        ORDER BY a.created_at DESC
      `)
      .all() as Record<string, unknown>[];

    return rows.map((row) => ({
      attempt: this.mapAttempt(row),
      progress:
        row.best_score == null
          ? undefined
          : {
              levelId: String(row.level_id),
              bestScore: Number(row.best_score),
              pass: Boolean(row.progress_pass),
              bestAttemptId: row.best_attempt_id ? String(row.best_attempt_id) : undefined,
              updatedAt: String(row.progress_updated_at)
            }
    }));
  }

  getAllProgress(): ProgressRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM progress ORDER BY level_id ASC`)
      .all() as Record<string, unknown>[];

    return rows.map((row) => ({
      levelId: String(row.level_id),
      bestScore: Number(row.best_score),
      pass: Boolean(row.pass),
      bestAttemptId: row.best_attempt_id ? String(row.best_attempt_id) : undefined,
      updatedAt: String(row.updated_at)
    }));
  }

  private mapAttempt(row: Record<string, unknown>): AttemptRecord {
    return {
      id: String(row.id),
      levelId: String(row.level_id),
      mode: row.mode === "recital" ? "recital" : "speech",
      status: row.status as AttemptRecord["status"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      totalScore: row.total_score == null ? undefined : Number(row.total_score),
      pass: row.pass == null ? undefined : Boolean(row.pass),
      transcript: row.transcript ? String(row.transcript) : undefined,
      liveTranscript: row.live_transcript ? String(row.live_transcript) : undefined,
      audioPath: row.audio_path ? String(row.audio_path) : undefined,
      report: row.report_json
        ? (JSON.parse(String(row.report_json)) as ScoreReport)
        : undefined
    };
  }
}

export function buildDbPath(dataDir: string) {
  return join(dataDir, "app.sqlite");
}

