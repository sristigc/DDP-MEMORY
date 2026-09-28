// Deterministic git/gh operations for fix mode. Claude never runs these: it only edits files inside the
// worktree this module prepares. Commit, push and PR happen here, and only after a human approved.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_RE = /^(?:novopay|trustt)-platform-[a-z0-9-]+$/i;
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,120}$/;

export function run(cmd, args, { cwd, timeoutMs = 10 * 60e3, exec = execFile } = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${String(stderr || err.message).trim().slice(0, 400)}`));
      resolve(String(stdout).trim());
    });
  });
}

/** Validates what the analysis pass proposed before any command uses it. */
export function validateTarget(target, repoRoot) {
  if (!target || !REPO_RE.test(target.repo || "")) throw new Error(`analysis did not name a valid microservice repo (got ${JSON.stringify(target?.repo)})`);
  if (!BRANCH_RE.test(target.base || "") || target.base.startsWith("-")) throw new Error(`invalid base branch ${JSON.stringify(target?.base)}`);
  const repoDir = path.join(repoRoot, target.repo);
  if (!fs.existsSync(path.join(repoDir, ".git"))) throw new Error(`${repoDir} is not a git repository on this machine`);
  return { repo: target.repo, base: target.base, repoDir };
}

/**
 * Fresh worktree on a new branch from origin/<base> — the "pull origin" step without touching the
 * developer's own working copy (which may have uncommitted changes).
 */
export async function prepareWorktree({ repoDir, base, branch, dir, exec }) {
  await run("git", ["-C", repoDir, "fetch", "origin", base], { exec });
  if (fs.existsSync(dir)) await run("git", ["-C", repoDir, "worktree", "remove", "--force", dir], { exec }).catch(() => {});
  await run("git", ["-C", repoDir, "worktree", "add", "-B", branch, dir, `origin/${base}`], { exec });
  return dir;
}

export async function diffOf(dir, { exec } = {}) {
  await run("git", ["-C", dir, "add", "-A", "--intent-to-add"], { exec }).catch(() => {});
  const stat = await run("git", ["-C", dir, "diff", "--stat"], { exec });
  const full = await run("git", ["-C", dir, "diff"], { exec });
  return { stat: stat.split("\n").pop() || "no changes", statFull: stat, diff: full.slice(0, 150_000), empty: !full.trim() };
}

/** After approval: commit, push the branch, open a draft PR. Returns the PR URL. */
export async function commitPushPr({ dir, branch, base, title, body, commitBody, exec }) {
  await run("git", ["-C", dir, "add", "-A"], { exec });
  await run("git", ["-C", dir, "commit", "-m", title, "-m", commitBody || body], { exec });
  await run("git", ["-C", dir, "push", "-u", "origin", branch], { exec, timeoutMs: 5 * 60e3 });
  const out = await run("gh", ["pr", "create", "--draft", "--base", base, "--head", branch, "--title", title, "--body", body], { cwd: dir, exec, timeoutMs: 5 * 60e3 });
  const url = (out.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) || [out])[0];
  return url;
}
