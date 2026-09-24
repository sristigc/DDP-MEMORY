-- DDP-AGENT job store. Idempotent: safe to run on every start.

CREATE TABLE IF NOT EXISTS jobs (
  id          BIGSERIAL PRIMARY KEY,
  jira_key    TEXT        NOT NULL,
  summary     TEXT        NOT NULL DEFAULT '',
  url         TEXT        NOT NULL DEFAULT '',
  status      TEXT        NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued', 'running', 'awaiting_local', 'succeeded', 'failed')),
  attempts    INT         NOT NULL DEFAULT 0,
  locked_by   TEXT,
  locked_at   TIMESTAMPTZ,
  result      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one open job per ticket; a finished ticket can be queued again later.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_open_per_ticket
  ON jobs (jira_key) WHERE status IN ('queued', 'running', 'awaiting_local');

CREATE INDEX IF NOT EXISTS jobs_queue ON jobs (status, created_at);

CREATE TABLE IF NOT EXISTS job_events (
  id          BIGSERIAL PRIMARY KEY,
  job_id      BIGINT      NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  step        TEXT        NOT NULL,
  type        TEXT        NOT NULL CHECK (type IN ('info', 'plan', 'handoff', 'error', 'done')),
  message     TEXT        NOT NULL,
  data        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_events_by_job ON job_events (job_id, at);
