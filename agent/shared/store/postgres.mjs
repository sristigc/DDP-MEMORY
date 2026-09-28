// Postgres job store. Claiming uses FOR UPDATE SKIP LOCKED so several runner replicas never
// pick the same job; a running job whose lock is older than staleAfterMs is reclaimed.
import fs from "node:fs";
import pg from "pg";

const SCHEMA = fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

export class PostgresStore {
  constructor(databaseUrl) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  }

  async migrate() { await this.pool.query(SCHEMA); }

  async enqueue({ jiraKey, summary = "", url = "" }) {
    const ins = await this.pool.query(
      `INSERT INTO jobs (jira_key, summary, url) VALUES ($1, $2, $3)
       ON CONFLICT (jira_key) WHERE status IN ('queued', 'running', 'awaiting_local') DO NOTHING
       RETURNING *`,
      [jiraKey, summary, url],
    );
    if (ins.rows[0]) return { created: true, job: ins.rows[0] };
    const open = await this.pool.query(
      `SELECT * FROM jobs WHERE jira_key = $1 AND status IN ('queued', 'running', 'awaiting_local') LIMIT 1`, [jiraKey]);
    return { created: false, job: open.rows[0] };
  }

  async claim(workerId, staleAfterMs = 30 * 60e3) {
    const res = await this.pool.query(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = $1, locked_at = now(), updated_at = now()
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'queued'
            OR (status = 'running' AND locked_at < now() - ($2::bigint * interval '1 millisecond'))
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
       RETURNING *`,
      [workerId, staleAfterMs],
    );
    return res.rows[0] || null;
  }

  async addEvent(jobId, { step, type, message, data = {} }) {
    await this.pool.query(`INSERT INTO job_events (job_id, step, type, message, data) VALUES ($1, $2, $3, $4, $5)`, [jobId, step, type, message, data]);
  }

  async finish(jobId, status, result = {}) {
    const res = await this.pool.query(
      `UPDATE jobs SET status = $2, result = $3, locked_by = NULL, locked_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
      [jobId, status, result],
    );
    if (!res.rows[0]) throw new Error(`job ${jobId} not found`);
    return res.rows[0];
  }

  async resume(jobId, note = "") {
    const res = await this.pool.query(
      `UPDATE jobs SET status = 'queued', result = result || jsonb_build_object('localNote', $2::text), updated_at = now()
       WHERE id = $1 AND status = 'awaiting_local' RETURNING *`,
      [jobId, note],
    );
    return res.rows[0] || null;
  }

  // ---------- local worker (ddp-worker on an office machine) ----------
  /** Leases the oldest job paused for a local step; a lease older than staleAfterMs can be taken over. */
  async claimLocal(workerId, staleAfterMs = 60 * 60e3) {
    const res = await this.pool.query(
      `UPDATE jobs SET locked_by = $1, locked_at = now(), updated_at = now()
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'awaiting_local'
           AND (locked_by IS NULL OR locked_at < now() - ($2::bigint * interval '1 millisecond'))
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
       RETURNING *`,
      [workerId, staleAfterMs],
    );
    return res.rows[0] || null;
  }

  async releaseLocal(jobId, workerId) {
    const res = await this.pool.query(
      `UPDATE jobs SET locked_by = NULL, locked_at = NULL
       WHERE id = $1 AND status = 'awaiting_local' AND locked_by = $2 RETURNING *`,
      [jobId, workerId],
    );
    return res.rows[0] || null;
  }

  // ---------- learning loop ----------
  async lastJob(jiraKey) {
    return (await this.pool.query(`SELECT * FROM jobs WHERE jira_key = $1 ORDER BY id DESC LIMIT 1`, [jiraKey])).rows[0] || null;
  }

  async jobsToScore() {
    return (await this.pool.query(`SELECT * FROM jobs WHERE status IN ('succeeded', 'failed', 'awaiting_local') ORDER BY id`)).rows;
  }

  async recordEpisode({ jobId, jiraKey, reward, signals }) {
    await this.pool.query(
      `INSERT INTO episodes (job_id, jira_key, reward, signals) VALUES ($1, $2, $3, $4)
       ON CONFLICT (job_id) DO UPDATE SET reward = EXCLUDED.reward, signals = EXCLUDED.signals, scored_at = now()`,
      [jobId, jiraKey, reward, signals],
    );
  }

  async getEpisode(jobId) {
    return (await this.pool.query(`SELECT * FROM episodes WHERE job_id = $1`, [jobId])).rows[0] || null;
  }

  async listEpisodes(limit = 100) {
    return (await this.pool.query(`SELECT * FROM episodes ORDER BY job_id DESC LIMIT $1`, [limit])).rows;
  }

  /** EMA update: weight += alpha * (reward - weight); evidence counts observations. */
  async reinforceLesson({ scope, kind, text, reward, alpha = 0.3 }) {
    const res = await this.pool.query(
      `INSERT INTO lessons (scope, kind, text, weight, evidence) VALUES ($1, $2, $3, $4::real * $5::real, 1)
       ON CONFLICT (scope, kind, text) DO UPDATE
         SET weight = lessons.weight + $5::real * ($4::real - lessons.weight), evidence = lessons.evidence + 1, updated_at = now()
       RETURNING *`,
      [scope, kind, text, reward, alpha],
    );
    return res.rows[0];
  }

  async topLessons(scopes, limit = 10) {
    return (await this.pool.query(
      `SELECT * FROM lessons WHERE scope = ANY($1) ORDER BY evidence DESC, abs(weight) DESC LIMIT $2`, [scopes, limit])).rows;
  }

  async get(jobId) { return (await this.pool.query(`SELECT * FROM jobs WHERE id = $1`, [jobId])).rows[0] || null; }
  async events(jobId) { return (await this.pool.query(`SELECT * FROM job_events WHERE job_id = $1 ORDER BY at, id`, [jobId])).rows; }
  async list({ status, limit = 50 } = {}) {
    const res = status
      ? await this.pool.query(`SELECT * FROM jobs WHERE status = $1 ORDER BY id DESC LIMIT $2`, [status, limit])
      : await this.pool.query(`SELECT * FROM jobs ORDER BY id DESC LIMIT $1`, [limit]);
    return res.rows;
  }
  async close() { await this.pool.end(); }
}
