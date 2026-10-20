import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

/** jira-flow-be/ */
export const appDir = fileURLToPath(new URL("../", import.meta.url));
/** The proactive-dpi-demo workspace root (shared .env, shared deps). */
export const demoDir = resolve(appDir, "../../");
export const projectEnvPath = resolve(demoDir, "../../.env");

/** Everything the agent flotte writes lives under one data dir. */
export const dataDir = join(appDir, ".data");
export const agentDbPath = join(dataDir, "agent.sqlite");
export const ticketDbPath = join(dataDir, "tickets.sqlite");

/** Base checkouts (one per repo, cloned once) and per-ticket worktrees off them. */
export const reposDir = join(dataDir, "repos");
export const worktreesDir = join(dataDir, "worktrees");

/** Config file, JSON so it needs no parser dependency. CLI/env can override single fields. */
export const configPath = resolve(demoDir, "jira-flow.config.json");
