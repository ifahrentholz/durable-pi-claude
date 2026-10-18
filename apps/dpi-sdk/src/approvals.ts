// Tool approvals (this fork): tool calls that change things wait for a person before they run.
//
// Each agent keeps its approval requests in the conversation document `demo.approvals`, keyed by tool call id, so a
// request survives restarts and the web client can show it at the call. Rules that skip the question live per session
// in `demo.approval-rules`, written in Claude Code's permission rule syntax: `Bash(git status:*)`, `edit`.

export const APPROVALS_DOC = "demo.approvals";
export const APPROVAL_RULES_DOC = "demo.approval-rules";

export type ApprovalStatus = "pending" | "allowed" | "always" | "denied";
export type ApprovalDecision = "allow" | "always" | "deny";

export type ApprovalItem = {
  callId: string;
  taskId: number;
  tool: string;
  /** What the call does, for the person deciding: the command for bash, the path for edits. */
  summary: string;
  /** Rules "always allow" adds. */
  rules: string[];
  status: ApprovalStatus;
  /** The person's note on a denial; the agent reads it. */
  message?: string;
  at: number;
  decidedAt?: number;
};

export type ApprovalsDoc = { items: Record<string, ApprovalItem> };
export type ApprovalRulesDoc = { allow: string[] };

/** Tools that ask before they run unless a rule allows them. Everything else (reads, App State) runs at once. */
export const APPROVAL_TOOLS = ["bash", "write", "edit", "start_session", "run_durable_job", "ping_on_call_engineer"];

/** Read-only issue tracker and forge commands, plus file edits (like Claude Code's acceptEdits). */
export const DEFAULT_RULES = [
  "edit",
  "write",
  "Bash(jira issue view:*)",
  "Bash(jira issue list:*)",
  "Bash(jira epic list:*)",
  "Bash(jira sprint list:*)",
  "Bash(glab mr view:*)",
  "Bash(glab mr list:*)",
  "Bash(glab mr diff:*)",
  "Bash(glab issue view:*)",
  "Bash(glab ci status:*)",
  "Bash(glab ci list:*)",
  "Bash(gh pr view:*)",
  "Bash(gh pr list:*)",
  "Bash(gh pr diff:*)",
  "Bash(gh pr checks:*)",
  "Bash(gh issue view:*)",
  "Bash(gh run view:*)",
  "Bash(gh run list:*)",
  "Bash(git status:*)",
  "Bash(git log:*)",
  "Bash(git diff:*)",
];

/** Shell syntax that could chain or redirect: a prefix rule never allows a command containing it. */
const SHELL_META = /[;&|`$<>\n\\]/;

/** Does `rule` allow this call? `Bash(prefix:*)` matches a simple command starting with the prefix; `Bash(cmd)` exactly. */
export function ruleAllows(rule: string, tool: string, args: Record<string, unknown>): boolean {
  const m = rule.trim().match(/^([\w-]+)(?:\((.*)\))?$/s);
  if (!m || m[1].toLowerCase() !== tool.toLowerCase()) return false;
  const content = m[2];
  if (content === undefined) return true;
  if (tool !== "bash") return false;
  const command = String(args.command ?? "").trim();
  if (content.endsWith(":*")) {
    const prefix = content.slice(0, -2).trim();
    return !SHELL_META.test(command) && (command === prefix || command.startsWith(`${prefix} `));
  }
  return command === content.trim();
}

/** The rule "always allow" would add for this call. */
export function suggestRule(tool: string, args: Record<string, unknown>): string {
  if (tool !== "bash") return tool;
  const command = String(args.command ?? "").trim();
  if (SHELL_META.test(command)) return `Bash(${command})`;
  const words = command.split(/\s+/);
  const prefix = words.slice(0, words.length > 2 ? 2 : words.length > 1 ? 2 : 1).join(" ");
  return `Bash(${prefix}:*)`;
}

export function describeCall(tool: string, args: Record<string, unknown>): string {
  if (tool === "bash") return String(args.command ?? "");
  for (const key of ["path", "file_path", "job", "name", "summary"]) if (typeof args[key] === "string") return `${tool}: ${args[key]}`;
  return `${tool} ${JSON.stringify(args).slice(0, 300)}`;
}
