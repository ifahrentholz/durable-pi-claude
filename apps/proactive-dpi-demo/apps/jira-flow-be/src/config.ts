import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { Tier } from "./types.ts";
import { configPath, projectEnvPath } from "./paths.ts";

// OPENROUTER_API_KEY etc. live in the demo workspace .env (shared with the proactive demo).
if (existsSync(projectEnvPath)) process.loadEnvFile(projectEnvPath);
// Device judge settings (DPI_JUDGE*) from ~/.dpi/backend.env, same as the proactive demo, never
// overriding a value already set. Lets `DPI_JUDGE=systemone` + a local Kev drive the classifier.
const deviceEnv = process.env.DPI_ENV_FILE ?? join(process.env.DPI_HOME ?? join(homedir(), ".dpi"), "backend.env");
if (existsSync(deviceEnv)) {
  const values = parseEnv(readFileSync(deviceEnv, "utf8"));
  for (const key of ["DPI_PROVIDER", "DPI_JUDGE", "DPI_JUDGE_URL", "DPI_JUDGE_API_KEY", "DPI_JUDGE_MODEL"])
    if (process.env[key] === undefined && values[key] !== undefined) process.env[key] = values[key];
}

export const POLL_INTERVALS = [5, 10, 15, 20, 30, 60] as const;
export type PollInterval = (typeof POLL_INTERVALS)[number];

/** One Jira project mapped to its GitLab repo. The Jira project key is the join key. */
export type ProjectMap = {
  gitlab: { host: string; repo: string };
  defaultBranch?: string;
  /** Override the clone URL; defaults to git@<host>:<repo>.git */
  remote?: string;
  /** Per-project branch template override (see branchTemplate). */
  branchTemplate?: string;
  /** Shell command submit_fix runs in the worktree before it commits, e.g. "npm test". None: no tests. */
  testCommand?: string;
};

export type FileConfig = {
  pollIntervalSec?: number;
  label?: string;
  maxConcurrent?: number;
  model?: string;
  /** Branch name template. Placeholders: {key} (PROJ-123), {key_lower} (proj-123),
   * {project} (PROJ), {number} (123). Default "feature/{key}". */
  branchTemplate?: string;
  /** When true the agent waits for approval and merges the MR itself. When false (default) it only
   * opens the MR and stops; a human reviews and merges in GitLab. */
  autoMerge?: boolean;
  approvalMode?: "both" | "gitlab-only" | "jira-only";
  /** Model of the independent reviewer. Pinned, never routed by tier. Default Opus. */
  reviewerModel?: string;
  /** Review rounds before a ticket with requested changes is blocked for the engineer. Default 2. */
  maxReviewRounds?: number;
  /** Independent review in the quick lane too. Default true: unattended it is the only check. */
  reviewQuick?: boolean;
  provider?: "claude-code" | "openrouter";
  thinking?: string;
  port?: number;
  host?: string;
  models?: {
    tiers?: Partial<Record<Lowercase<Tier>, string>>;
    floor?: string;
    ceiling?: string;
    fallback?: string;
  };
  projects?: Record<string, ProjectMap>;
};

const file: FileConfig = existsSync(configPath)
  ? (JSON.parse(readFileSync(configPath, "utf8")) as FileConfig)
  : {};

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => {
  const i = args.indexOf(key);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw Error(`${key} needs a value`);
  return args[i + 1];
};

const provider = (option("--provider", file.provider ?? "claude-code")) as "claude-code" | "openrouter";
if (!["claude-code", "openrouter"].includes(provider)) throw Error("--provider is claude-code or openrouter");

const pollIntervalSec = Number(option("--poll", String(file.pollIntervalSec ?? 30)));
if (!POLL_INTERVALS.includes(pollIntervalSec as PollInterval))
  throw Error(`--poll is one of ${POLL_INTERVALS.join(", ")}`);

const DEFAULT_TIERS: Record<Lowercase<Tier>, string> = {
  simple: "claude-sonnet-5-5",
  moderate: "claude-sonnet-5-5",
  complex: "claude-opus-5-5",
};

export const config = {
  provider,
  port: Number(option("--port", String(file.port ?? 4791))),
  host: option("--host", file.host ?? "127.0.0.1"),
  dev: args.includes("--dev"),
  /** Default agent model (also the ceiling): Opus 5.5. */
  model: option("--model", file.model ?? "claude-opus-5-5"),
  thinking: option("--thinking", file.thinking ?? "high") as
    | "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
  pollIntervalSec: pollIntervalSec as PollInterval,
  /** Global JQL filter: tickets labelled this are picked up. */
  label: option("--label", file.label ?? "ready-for-agent"),
  maxConcurrent: Number(option("--max", String(file.maxConcurrent ?? 3))),
  /** Default: only open the MR, let a human merge. Pass --auto-merge or set autoMerge:true to auto-merge. */
  autoMerge: args.includes("--auto-merge") ? true : (file.autoMerge ?? false),
  /** Branch name template; placeholders {key} {key_lower} {project} {number}. */
  branchTemplate: option("--branch", file.branchTemplate ?? "feature/{key}"),
  approvalMode: option("--approval", file.approvalMode ?? "both") as
    | "both" | "gitlab-only" | "jira-only",
  reviewerModel: file.reviewerModel ?? "claude-opus-5-5",
  maxReviewRounds: file.maxReviewRounds ?? 2,
  reviewQuick: file.reviewQuick ?? true,
  /** Complexity-based model routing. Floor never goes below; ceiling is the default. */
  tiers: { ...DEFAULT_TIERS, ...(file.models?.tiers ?? {}) },
  floor: file.models?.floor ?? "claude-sonnet-5-5",
  ceiling: file.models?.ceiling ?? "claude-opus-5-5",
  fallback: file.models?.fallback ?? "claude-opus-5-5",
  projects: file.projects ?? {},
};

/** The JQL the poller runs: labelled tickets across the mapped projects, highest priority first. */
export function pollJql(): string {
  const projects = Object.keys(config.projects);
  const scope = projects.length ? `project in (${projects.join(", ")}) AND ` : "";
  return `${scope}labels = "${config.label}" AND statusCategory != Done ORDER BY priority DESC, created ASC`;
}
