// Step executors. DryRunExecutor records what would happen (plus real memory recall for step 1);
// LiveExecutor is the slot for the Claude Agent SDK once credentials are provided.

export class DryRunExecutor {
  mode = "dry-run";
  constructor({ memory, store }) { this.memory = memory; this.store = store; }

  async run(step, job) {
    const data = { drivers: step.drivers, mode: "dry-run" };
    if (step.memory === "recall") {
      const hits = await this.memory.recall(`${job.jira_key} ${job.summary}`.trim());
      data.pastContext = hits.length;
      if (this.store?.topLessons) {
        // Learned policy: the most-evidenced lessons for this ticket, its project and everything.
        const scopes = [job.jira_key, String(job.jira_key).split("-")[0], "global"];
        const lessons = await this.store.topLessons(scopes, 5);
        data.lessonsApplied = lessons.map((l) => ({ scope: l.scope, kind: l.kind, weight: Number(l.weight.toFixed(2)), text: l.text.slice(0, 200) }));
      }
    }
    return { type: "plan", message: `Would run step ${step.n} · ${step.name} with ${step.drivers.join(", ")}`, data };
  }
}

export class LiveExecutor {
  mode = "live";
  async run(step) {
    // Deliberately not implemented yet: live runs need ANTHROPIC_API_KEY, GitHub + Jira write access
    // and a review of what the agent may do unattended. Fail loudly instead of pretending.
    throw new Error(`live mode is not enabled yet (step ${step.id}); set AGENT_MODE=dry-run`);
  }
}

export function createExecutor({ mode, memory, store }) {
  return mode === "live" ? new LiveExecutor() : new DryRunExecutor({ memory, store });
}
