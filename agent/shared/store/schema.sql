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

-- Learning loop (learner service). One episode per finished/paused job, scored from real outcomes.
CREATE TABLE IF NOT EXISTS episodes (
  job_id      BIGINT      PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  jira_key    TEXT        NOT NULL,
  reward      REAL        NOT NULL,
  signals     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  scored_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lessons the runner recalls. weight moves toward observed rewards (exponential moving average).
CREATE TABLE IF NOT EXISTS lessons (
  id          BIGSERIAL   PRIMARY KEY,
  scope       TEXT        NOT NULL,               -- ticket key, project key or 'global'
  kind        TEXT        NOT NULL,               -- e.g. reopened, qa-passed, local-note, slow-handoff
  text        TEXT        NOT NULL,
  weight      REAL        NOT NULL DEFAULT 0,
  evidence    INT         NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope, kind, text)
);
