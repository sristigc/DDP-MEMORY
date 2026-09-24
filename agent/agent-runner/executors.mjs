// Step executors. DryRunExecutor records what would happen (plus real memory recall for step 1);
// LiveExecutor is the slot for the Claude Agent SDK once credentials are provided.

export class DryRunExecutor {
  mode = "dry-run";
  constructor({ memory }) { this.memory = memory; }

  async run(step, job) {
    const data = { drivers: step.drivers, mode: "dry-run" };
    if (step.memory === "recall") {
      const hits = await this.memory.recall(`${job.jira_key} ${job.summary}`.trim());
      data.pastContext = hits.length;
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

export function createExecutor({ mode, memory }) {
  return mode === "live" ? new LiveExecutor() : new DryRunExecutor({ memory });
}
