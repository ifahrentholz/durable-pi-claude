// Each ticket agent works in its own git worktree of its mapped repo, on its own branch.
// A repo is cloned once into a base checkout; worktrees branch off its default branch.
//
// Everything here is async on purpose: this module runs inside the HTTP server's process, and a
// synchronous `git clone` or test run would freeze every request and SSE stream until it ends.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cli, type CliError } from "./cli.ts";
import { reposDir, worktreesDir } from "./paths.ts";
import type { RepoTarget } from "./types.ts";

async function git(cwd: string, ...args: string[]) {
  return (await cli("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 })).trim();
}

/** Resolves true when the git command exits 0, false otherwise. */
async function gitSucceeds(cwd: string, ...args: string[]) {
  try {
    await cli("git", args, { cwd });
    return true;
  } catch {
    return false;
  }
}

// One git operation at a time per base checkout: two tickets of the same repo started together must
// not clone into, or add worktrees to, the same directory concurrently.
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
  queues.set(key, next);
  void next
    .catch(() => {})
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  return next;
}

/** Clone the repo once into its base checkout (or fetch), then create or re-attach the ticket's worktree. */
export function prepareWorktree(target: RepoTarget) {
  return serialized(target.base, async () => {
    await ensureBase(target);
    await ensureWorktree(target);
  });
}

async function ensureBase(target: RepoTarget) {
  await mkdir(reposDir, { recursive: true });
  if (!existsSync(join(target.base, ".git"))) {
    await git(reposDir, "clone", "--quiet", target.remote, target.base);
    return;
  }
  // Offline is fine; the worktree still works against the last fetch.
  await git(target.base, "fetch", "--quiet", "origin").catch(() => {});
}

async function ensureWorktree(target: RepoTarget) {
  await mkdir(worktreesDir, { recursive: true });
  if (existsSync(join(target.worktree, ".git"))) return;
  await git(target.base, "worktree", "prune");
  const branchExists = await gitSucceeds(target.base, "rev-parse", "--verify", "--quiet", `refs/heads/${target.branch}`);
  if (branchExists) await git(target.base, "worktree", "add", "-q", target.worktree, target.branch);
  else
    await git(target.base, "worktree", "add", "-q", "-b", target.branch, target.worktree, `origin/${target.defaultBranch}`);
}

/** Stage and commit everything in the worktree. Returns the short head, or null if nothing changed. */
export async function commitAll(worktree: string, message: string): Promise<string | null> {
  await git(worktree, "add", "-A");
  // `git diff --cached --quiet` exits non-zero exactly when there are staged changes.
  if (await gitSucceeds(worktree, "diff", "--cached", "--quiet")) return null;
  await git(worktree, "commit", "-q", "-m", message);
  return git(worktree, "rev-parse", "--short", "HEAD");
}

/** Push the ticket branch to origin, setting upstream so the MR can be opened. */
export async function pushBranch(target: RepoTarget) {
  await git(target.worktree, "push", "-u", "origin", target.branch);
}

/** What a reviewer sees: commits on the branch and the diff against the default branch. */
export async function branchReview(target: RepoTarget) {
  if (!existsSync(join(target.worktree, ".git")))
    return { ahead: 0, head: null as string | null, log: "", diffStat: "", diff: "" };
  const base = `origin/${target.defaultBranch}`;
  const [ahead, head, log, diffStat, diff] = await Promise.all([
    git(target.worktree, "rev-list", "--count", `${base}..HEAD`),
    git(target.worktree, "rev-parse", "--short", "HEAD"),
    git(target.worktree, "log", "--format=%h %an: %s", `${base}..HEAD`),
    git(target.worktree, "diff", "--stat", `${base}...HEAD`),
    git(target.worktree, "diff", `${base}...HEAD`),
  ]);
  return { ahead: Number(ahead), head: head as string | null, log, diffStat, diff };
}

/** Run the project's test command in the worktree, if one is configured. Returns pass/fail + output. */
export async function runTests(worktree: string, command: string | null) {
  if (!command) return { ran: false, ok: true, summary: "No test command configured." };
  try {
    const stdout = await cli("bash", ["-lc", command], { cwd: worktree, timeout: 300_000 });
    return { ran: true, ok: true, summary: stdout.slice(-4000) };
  } catch (e) {
    const err = e as CliError;
    const timedOut = err.killed ? "\n(killed after 300 s)" : "";
    return { ran: true, ok: false, summary: `${err.stdout ?? ""}${err.stderr ?? ""}${timedOut}`.slice(-4000) };
  }
}

/** Remove a ticket's worktree (e.g. when it is cancelled). Keeps the branch. */
export async function removeWorktree(target: RepoTarget) {
  if (!existsSync(target.worktree)) return;
  await serialized(target.base, () => git(target.base, "worktree", "remove", "--force", target.worktree)).catch(
    () => {}, // best effort
  );
}
