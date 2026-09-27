// Reward model for the learning loop. An episode is one DDP-AGENT job; its reward comes from what
// actually happened to the Jira ticket afterwards, not from the agent's own opinion of its work.

export const REWARDS = { done: 1, qa: 0.5, reopened: -1, failed: -0.5, slowHandoff: -0.1 };
const QA_RE = /\bqa\b|ready for qa|qa in progress|uat/i;
const REOPEN_RE = /reopen/i;
const SLOW_HANDOFF_HOURS = 24;

const project = (key) => String(key).split("-")[0];

/** Signals observed for a job, from the job row, its events and the ticket's Jira history. */
export function observe(job, history, now = Date.now()) {
  const since = Date.parse(job.created_at);
  const after = (history?.transitions || []).filter((t) => Date.parse(t.at) >= since);
  const reopened = after.some((t) => REOPEN_RE.test(t.to) || (/done|closed|qa/i.test(t.from || "") && /in progress|to do|open/i.test(t.to || "")));
  const reachedQA = after.some((t) => QA_RE.test(t.to)) || QA_RE.test(history?.status || "");
  const reachedDone = history?.category === "done";
  const waitHours = job.status === "awaiting_local" ? (now - Date.parse(job.updated_at)) / 3.6e6 : 0;
  return {
    jobStatus: job.status,
    ticketStatus: history?.status || "unknown",
    reopened,
    reachedQA,
    reachedDone,
    waitHours: Math.round(waitHours * 10) / 10,
    transitionsSinceJob: after.map((t) => `${t.from} → ${t.to}`),
    localNote: job.result?.localNote || null,
    error: job.result?.error || null,
  };
}

/** Scalar reward in [-1, 1]. */
export function reward(s) {
  let r = 0;
  if (s.reachedDone) r += REWARDS.done;
  else if (s.reachedQA) r += REWARDS.qa;
  if (s.reopened) r += REWARDS.reopened;
  if (s.jobStatus === "failed") r += REWARDS.failed;
  if (s.waitHours > SLOW_HANDOFF_HOURS) r += REWARDS.slowHandoff;
  return Math.max(-1, Math.min(1, Math.round(r * 100) / 100));
}

/** Stable fingerprint: a job is only re-learned from when its observed outcome changes. */
export function signature(s) {
  return JSON.stringify([s.jobStatus, s.ticketStatus, s.reopened, s.reachedQA, s.reachedDone, s.waitHours > SLOW_HANDOFF_HOURS, s.localNote, s.error]);
}

/** Lessons to reinforce with this episode's reward. Scopes: ticket, project, global. */
export function lessonsFor(job, s) {
  const key = job.jira_key;
  const proj = project(key);
  const out = [];
  if (s.reopened) {
    out.push({ scope: proj, kind: "reopened", text: `${proj} tickets have been reopened after agent work (${key}: ${s.transitionsSinceJob.join(", ") || "status moved back"}). Before handing off, confirm the fix is on the release branch and every entry point of the flow is covered.` });
  }
  if (s.reachedDone || s.reachedQA) {
    out.push({ scope: proj, kind: s.reachedDone ? "done" : "qa-reached", text: `${key} reached ${s.ticketStatus} after the Phase 1 flow; the same step sequence worked for ${proj}.` });
  }
  if (s.localNote) {
    out.push({ scope: key, kind: "local-note", text: s.localNote });
    out.push({ scope: proj, kind: "local-note", text: `${key}: ${s.localNote}` });
  }
  if (s.waitHours > SLOW_HANDOFF_HOURS) {
    out.push({ scope: "global", kind: "slow-handoff", text: "Jobs wait more than a day at the local log step; check logs and resume sooner, or add log access for the runner." });
  }
  if (s.error) {
    out.push({ scope: "global", kind: "failure", text: `Runner failure seen: ${String(s.error).slice(0, 200)}` });
  }
  return out;
}
