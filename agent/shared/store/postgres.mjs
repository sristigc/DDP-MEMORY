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
