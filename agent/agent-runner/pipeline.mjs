// The Phase 1 delivery flow as data. Each step names the .claude/ agents, commands and skills that
// drive it; the runner loads those .md files from the toolkit repo instead of hard-coding behaviour.
// `where: "local"` steps need the office network (QA/UAT servers on 172.31.x.x) and are handed back
// to a developer's Claude Code; the job pauses as `awaiting_local` until resumed.

export const STEPS = [
  { id: "context", n: 1, name: "Get Jira context", where: "cloud", drivers: ["agent:context-fetch", "agent:fullstack-agent", "command:jira-ticket"], memory: "recall" },
  { id: "subtask", n: 2, name: "Create dev subtask", where: "cloud", drivers: ["command:jira-ticket"] },
  { id: "logs", n: 3, name: "Look at logs", where: "local", drivers: ["skill:app-servers"] },
  { id: "pull", n: 4, name: "Pull origin", where: "cloud", drivers: ["skill:git-workflow"] },
  { id: "change", n: 5, name: "Make changes + gradle build", where: "cloud", drivers: ["agent:coding-agent", "agent:review-agent"], memory: "save" },
  { id: "commit", n: 6, name: "Commit", where: "cloud", drivers: ["skill:git-workflow"] },
  { id: "push", n: 7, name: "Push", where: "cloud", drivers: ["skill:git-workflow"] },
  { id: "pr", n: 8, name: "Raise PR + send to Google Chat", where: "cloud", drivers: ["skill:git-workflow"], notify: true },
  { id: "review", n: 9, name: "Post-review", where: "cloud", drivers: ["agent:review-agent"], memory: "save" },
];

export function stepIndex(id) {
  const i = STEPS.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`unknown step ${id}`);
  return i;
}

/**
 * Runs the job from `fromStep` until it finishes or reaches a local step.
 * @returns {{ status: "succeeded" | "awaiting_local", nextStep: string | null }}
 */
export async function runPipeline(job, { executor, store, fromStep = STEPS[0].id }) {
  for (const step of STEPS.slice(stepIndex(fromStep))) {
    if (step.where === "local") {
      await store.addEvent(job.id, { step: step.id, type: "handoff", message: `Step ${step.n} (${step.name}) must run on the office network`, data: { drivers: step.drivers } });
      const next = STEPS[stepIndex(step.id) + 1];
      return { status: "awaiting_local", nextStep: next ? next.id : null, handoffStep: step.id };
    }
    const outcome = await executor.run(step, job);
    await store.addEvent(job.id, { step: step.id, type: outcome.type || "info", message: outcome.message, data: outcome.data || {} });
  }
  return { status: "succeeded", nextStep: null };
}
