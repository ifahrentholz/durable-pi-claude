// Read-only smoke test for the CLI adapters. Run: npx tsx apps/jira-flow-be/src/smoke.ts
import { Jira } from "./jira.ts";
import { cli } from "./cli.ts";
import { config } from "./config.ts";

const jira = new Jira();
try {
  const issues = await jira.list("created >= -60d ORDER BY created DESC");
  console.log(`[jira] parsed ${issues.length} issue(s)`);
  for (const i of issues.slice(0, 5))
    console.log(`  ${i.key}  [${i.priority}]  ${i.status}  "${i.summary.slice(0, 50)}"  labels=${i.labels.join(",")}`);
} catch (e) {
  console.error("[jira] FAILED:", e instanceof Error ? e.message : e);
}

// GitLab connectivity (read-only): the current user on every GitLab host the project map uses.
const hosts = [...new Set(Object.values(config.projects).map((p) => p.gitlab.host))];
if (!hosts.length) console.log("[glab] no projects mapped in jira-flow.config.json");
for (const host of hosts) {
  try {
    const user = JSON.parse(await cli("glab", ["api", "--hostname", host, "user"])) as { username?: string };
    console.log(`[glab] ${host}: api OK, authenticated as ${user.username}`);
  } catch (e) {
    console.error(`[glab] ${host} FAILED:`, e instanceof Error ? e.message : e);
  }
}
