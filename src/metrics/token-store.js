import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export class TokenStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        hour_bucket TEXT NOT NULL,
        session_key TEXT NOT NULL,
        lane TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_read_tokens INTEGER NOT NULL DEFAULT 0,
        thought_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_token_events_ts ON token_events(ts);
      CREATE INDEX IF NOT EXISTS idx_token_events_hour ON token_events(hour_bucket);
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO token_events (
        ts, hour_bucket, session_key, lane, model,
        input_tokens, output_tokens, cached_read_tokens, thought_tokens, total_tokens, latency_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  record({
    sessionKey = 'unknown',
    lane = 'group',
    model = 'unknown',
    usage = {},
    latencyMs = 0
  }) {
    const now = Date.now();
    const d = new Date(now);
    const pad = (n) => String(n).padStart(2, '0');
    const hourBucket = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;

    const inputTokens = Math.max(0, Number(usage.inputTokens || 0));
    const outputTokens = Math.max(0, Number(usage.outputTokens || 0));
    const cachedReadTokens = Math.max(0, Number(usage.cachedReadTokens || 0));
    const thoughtTokens = Math.max(0, Number(usage.thoughtTokens || 0));
    const totalTokens = Math.max(
      0,
      Number(usage.totalTokens || inputTokens + outputTokens + cachedReadTokens)
    );

    this.insertStmt.run(
      now,
      hourBucket,
      String(sessionKey),
      String(lane),
      String(model),
      inputTokens,
      outputTokens,
      cachedReadTokens,
      thoughtTokens,
      totalTokens,
      Math.max(0, Math.round(Number(latencyMs || 0)))
    );
  }

  getDashboard(hours = 24) {
    const since = Date.now() - Math.max(1, Number(hours || 24)) * 3600 * 1000;
    const totals = this.db
      .prepare(`
        SELECT
          COUNT(*) AS turns,
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(SUM(cached_read_tokens), 0) AS cachedReadTokens,
          COALESCE(SUM(thought_tokens), 0) AS thoughtTokens,
          COALESCE(SUM(total_tokens), 0) AS totalTokens,
          COALESCE(AVG(latency_ms), 0) AS avgLatencyMs
        FROM token_events
      `)
      .get();

    const byLane = this.db
      .prepare(`
        SELECT
          lane,
          COUNT(*) AS turns,
          COALESCE(SUM(total_tokens), 0) AS totalTokens,
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(AVG(latency_ms), 0) AS avgLatencyMs
        FROM token_events
        GROUP BY lane
      `)
      .all();

    const byModel = this.db
      .prepare(`
        SELECT
          model,
          COUNT(*) AS turns,
          COALESCE(SUM(total_tokens), 0) AS totalTokens,
          COALESCE(AVG(latency_ms), 0) AS avgLatencyMs
        FROM token_events
        GROUP BY model
        ORDER BY totalTokens DESC
      `)
      .all();

    const hourly = this.db
      .prepare(`
        SELECT
          hour_bucket AS hour,
          COUNT(*) AS turns,
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(SUM(cached_read_tokens), 0) AS cachedReadTokens,
          COALESCE(SUM(total_tokens), 0) AS totalTokens
        FROM token_events
        WHERE ts >= ?
        GROUP BY hour_bucket
        ORDER BY hour_bucket ASC
      `)
      .all(since);

    const recent = this.db
      .prepare(`
        SELECT id, ts, session_key AS sessionKey, lane, model,
               input_tokens AS inputTokens, output_tokens AS outputTokens,
               cached_read_tokens AS cachedReadTokens, total_tokens AS totalTokens,
               latency_ms AS latencyMs
        FROM token_events
        ORDER BY id DESC
        LIMIT 20
      `)
      .all();

    return {
      totals: {
        turns: Number(totals.turns || 0),
        inputTokens: Number(totals.inputTokens || 0),
        outputTokens: Number(totals.outputTokens || 0),
        cachedReadTokens: Number(totals.cachedReadTokens || 0),
        thoughtTokens: Number(totals.thoughtTokens || 0),
        totalTokens: Number(totals.totalTokens || 0),
        avgLatencyMs: Math.round(Number(totals.avgLatencyMs || 0))
      },
      byLane,
      byModel,
      hourly,
      recent
    };
  }

  close() {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}
