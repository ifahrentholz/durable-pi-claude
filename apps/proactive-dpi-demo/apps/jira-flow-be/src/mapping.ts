// Resolves a Jira ticket to the GitLab repo and the local worktree it should be built in.
// Primary: the project map in jira-flow.config.json, keyed by Jira project key.
// Override: a per-ticket label `repo:<group/project>` for the monorepo/multi-repo exception.
import { join } from "node:path";
import { config } from "./config.ts";
import { reposDir, worktreesDir } from "./paths.ts";
import type { JiraIssue, RepoTarget } from "./types.ts";

function slug(repo: string) {
  return repo.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

/** Render a branch name from a template. {key}=PROJ-123, {key_lower}=proj-123, {project}=PROJ, {number}=123. */
function renderBranch(template: string, issue: JiraIssue): string {
  const number = issue.key.includes("-") ? issue.key.slice(issue.key.indexOf("-") + 1) : issue.key;
  return template
    .replace(/\{key_lower\}/g, issue.key.toLowerCase())
    .replace(/\{key\}/g, issue.key)
    .replace(/\{project\}/g, issue.project)
    .replace(/\{number\}/g, number);
}

/** Returns the repo target for a ticket, or null when no mapping applies (caller flags it in Jira). */
export function resolveRepo(issue: JiraIssue): RepoTarget | null {
  const project = config.projects[issue.project];
  if (!project) return null;

  const override = issue.labels.map((l) => l.match(/^repo:(.+)$/)?.[1]).find(Boolean);
  const host = project.gitlab.host;
  const repo = override ?? project.gitlab.repo;
  const defaultBranch = project.defaultBranch ?? "main";
  const remote = project.remote ?? `git@${host}:${repo}.git`;
  const base = join(reposDir, slug(repo));
  const worktree = join(worktreesDir, issue.key);
  const branch = renderBranch(project.branchTemplate ?? config.branchTemplate, issue);

  return { host, repo, remote, defaultBranch, base, worktree, branch };
}
