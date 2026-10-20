// Thin adapter over the `jira` CLI (ankitpokhrel/jira-cli), already configured on this machine.
// It shells out and parses the raw Jira REST JSON, so nothing here depends on an API token in-process.
import { cli } from "./cli.ts";
import type { JiraIssue, Priority } from "./types.ts";

const PRIORITIES: Priority[] = ["Highest", "High", "Medium", "Low", "Lowest"];
function toPriority(name: unknown): Priority {
  // Jira instances often prefix the name with a rank, e.g. "3. Medium" or "1. Highest".
  const raw = String(name ?? "").trim();
  const rank = raw.match(/^([1-5])\b/)?.[1];
  const n = raw.replace(/^[1-5]\.?\s*/, "").trim();
  const hit = PRIORITIES.find((p) => p.toLowerCase() === n.toLowerCase());
  if (hit) return hit;
  // Common Jira synonyms.
  if (/^(blocker|critical|p1)$/i.test(n)) return "Highest";
  if (/^(major|p2)$/i.test(n)) return "High";
  if (/^(minor|p3)$/i.test(n)) return "Low";
  if (/^(trivial|p4)$/i.test(n)) return "Lowest";
  // Fall back to the numeric rank, 1 (Highest) .. 5 (Lowest).
  if (rank) return PRIORITIES[Number(rank) - 1] ?? "Medium";
  return "Medium";
}

/** Jira Cloud descriptions can be plain strings or ADF (Atlassian Document Format) JSON. Flatten to text. */
function adfToText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  const n = node as { type?: string; text?: string; content?: unknown };
  if (n.type === "text" && typeof n.text === "string") return n.text;
  let out = adfToText(n.content);
  if (n.type === "paragraph" || n.type === "heading") out += "\n";
  return out;
}

type RawIssue = {
  key: string;
  fields: {
    summary?: string;
    priority?: { name?: string } | null;
    status?: { name?: string } | null;
    created?: string;
    updated?: string;
    labels?: string[];
    reporter?: { displayName?: string } | null;
    project?: { key?: string } | null;
    description?: unknown;
  };
};

function mapIssue(raw: RawIssue): JiraIssue {
  const f = raw.fields ?? {};
  return {
    key: raw.key,
    project: f.project?.key ?? raw.key.split("-")[0],
    summary: f.summary ?? "",
    priority: toPriority(f.priority?.name),
    status: f.status?.name ?? "",
    created: f.created ?? new Date().toISOString(),
    updatedAt: f.updated ?? f.created ?? new Date().toISOString(),
    labels: Array.isArray(f.labels) ? f.labels : [],
    reporter: f.reporter?.displayName ?? null,
    description: adfToText(f.description).trim(),
  };
}

export class Jira {
  constructor(private readonly bin = "jira") {}

  private jira(args: string[]): Promise<string> {
    return cli(this.bin, args, { timeout: 30_000 });
  }

  /**
   * Every issue matching the JQL. jira-cli appends its own ORDER BY, so any ORDER BY in the query
   * must be stripped here; the caller sorts by priority client-side (see types PRIORITY_ORDER).
   */
  async list(jql: string): Promise<JiraIssue[]> {
    const filter = jql.replace(/\s+ORDER\s+BY\s+.*$/i, "").trim();
    let out: string;
    try {
      out = await this.jira(["issue", "list", "-q", filter, "--raw", "--paginate", "0:100"]);
    } catch (e) {
      // jira-cli exits non-zero with "No result found" when the query matches nothing.
      const stderr = String((e as { stderr?: string }).stderr ?? (e as Error).message ?? "");
      if (/no result found|no issues? found/i.test(stderr)) return [];
      throw e;
    }
    const text = out.trim();
    if (!text) return [];
    const data = JSON.parse(text) as { issues?: RawIssue[] } | RawIssue[];
    const issues = Array.isArray(data) ? data : (data.issues ?? []);
    return issues.map(mapIssue);
  }

  /** One issue in full (used when the list view truncates the description). */
  async view(key: string): Promise<JiraIssue> {
    const out = await this.jira(["issue", "view", key, "--raw"]);
    return mapIssue(JSON.parse(out.trim()) as RawIssue);
  }

  /** Append a comment. The flow uses this for documentation summaries and blocked notices. */
  async comment(key: string, body: string): Promise<void> {
    await this.jira(["issue", "comment", "add", key, body, "--no-input"]);
  }

  /** Move the issue to a named status (Jira transition). No-op friendly: caller catches unknown states. */
  async transition(key: string, toStatus: string): Promise<void> {
    await this.jira(["issue", "move", key, toStatus]);
  }

  /** Recent comments as flattened text, newest last. Used to poll for an /approve or /decline. */
  async comments(key: string): Promise<{ author: string; body: string; createdAt: string }[]> {
    const out = await this.jira(["issue", "view", key, "--raw"]);
    const raw = JSON.parse(out.trim()) as {
      fields?: { comment?: { comments?: { author?: { displayName?: string }; body?: unknown; created?: string }[] } };
    };
    const list = raw.fields?.comment?.comments ?? [];
    return list.map((c) => ({
      author: c.author?.displayName ?? "",
      body: adfToText(c.body).trim(),
      createdAt: c.created ?? "",
    }));
  }
}
