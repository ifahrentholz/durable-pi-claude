// Thin adapter over the `glab` CLI, authenticated on this machine for the GitLab host of each mapped project.
// MR commands target a remote repo with -R <host>/<group>/<project>; reads go through `glab api`.
import { cli } from "./cli.ts";

export type MrRef = { iid: number; url: string };
export type ApprovalState = { approved: boolean; approvedBy: string[] };

export class GitLab {
  constructor(private readonly bin = "glab") {}

  private glab(args: string[], cwd?: string): Promise<string> {
    return cli(this.bin, args, { cwd, timeout: 60_000 });
  }

  /** `-R` target: host/group/project, which glab resolves against the matching auth entry. */
  private target(host: string, repo: string) {
    return `${host}/${repo}`;
  }

  /** URL-encoded project id for the REST API (group/project -> group%2Fproject). */
  private encoded(repo: string) {
    return encodeURIComponent(repo);
  }

  /**
   * Open an MR for an already-pushed branch. Returns its iid and web URL.
   * glab prints the URL on the last line; we also read it back by iid for certainty.
   */
  async createMr(opts: {
    host: string;
    repo: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
    /** Run from the worktree so glab resolves the GitLab remote (origin), not the backend's cwd. */
    cwd?: string;
    draft?: boolean;
  }): Promise<MrRef> {
    const out = await this.glab([
      "mr", "create",
      "-R", this.target(opts.host, opts.repo),
      "--source-branch", opts.sourceBranch,
      "--target-branch", opts.targetBranch,
      "--title", opts.title,
      "--description", opts.description,
      ...(opts.draft ? ["--draft"] : []),
      "--yes",
    ], opts.cwd);
    const url = (out.match(/https?:\/\/\S+\/-\/merge_requests\/\d+/) ?? [])[0] ?? out.trim().split("\n").pop() ?? "";
    const iid = Number((url.match(/merge_requests\/(\d+)/) ?? [])[1] ?? 0);
    return { iid, url };
  }

  /** Update an MR: its description, and draft (true) or ready (false). */
  async updateMr(host: string, repo: string, iid: number, change: { description?: string; draft?: boolean }, cwd?: string) {
    const flags = [
      ...(change.description !== undefined ? ["--description", change.description] : []),
      ...(change.draft === true ? ["--draft"] : change.draft === false ? ["--ready"] : []),
    ];
    if (flags.length) await this.glab(["mr", "update", String(iid), "-R", this.target(host, repo), ...flags], cwd);
  }

  /** Post a comment on the MR (REST; `glab mr note` is experimental). */
  async note(host: string, repo: string, iid: number, body: string, cwd?: string) {
    await this.glab([
      "api", "--hostname", host, "--method", "POST",
      `projects/${this.encoded(repo)}/merge_requests/${iid}/notes`,
      "--raw-field", `body=${body}`,
    ], cwd);
  }

  /** The open MR for a source branch, if one already exists (makes open_mr idempotent on retry). */
  async findMrForBranch(host: string, repo: string, branch: string, cwd?: string): Promise<MrRef | null> {
    const out = await this.glab([
      "api", "--hostname", host,
      `projects/${this.encoded(repo)}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`,
    ], cwd);
    const list = JSON.parse(out.trim()) as { iid?: number; web_url?: string }[];
    const mr = list[0];
    return mr?.iid ? { iid: mr.iid, url: mr.web_url ?? "" } : null;
  }

  /** Current approval state from the REST API. Empty approvedBy means not yet approved. */
  async approvals(host: string, repo: string, iid: number, cwd?: string): Promise<ApprovalState> {
    const out = await this.glab([
      "api", "--hostname", host,
      `projects/${this.encoded(repo)}/merge_requests/${iid}/approvals`,
    ], cwd);
    const data = JSON.parse(out.trim()) as {
      approved?: boolean;
      approved_by?: { user?: { username?: string } }[];
    };
    const approvedBy = (data.approved_by ?? []).map((a) => a.user?.username ?? "").filter(Boolean);
    return { approved: Boolean(data.approved) || approvedBy.length > 0, approvedBy };
  }

  /** Merge the MR. Fails loudly if the MR cannot be merged (conflicts, pipeline, etc.). */
  async merge(host: string, repo: string, iid: number, cwd?: string): Promise<void> {
    await this.glab([
      "mr", "merge", String(iid),
      "-R", this.target(host, repo),
      "--yes", "--remove-source-branch",
    ], cwd);
  }

  /** One MR's merge status, e.g. "can_be_merged". */
  async mergeStatus(host: string, repo: string, iid: number): Promise<string> {
    const out = await this.glab([
      "api", "--hostname", host,
      `projects/${this.encoded(repo)}/merge_requests/${iid}`,
    ]);
    const data = JSON.parse(out.trim()) as { merge_status?: string; detailed_merge_status?: string };
    return data.detailed_merge_status ?? data.merge_status ?? "unknown";
  }
}
