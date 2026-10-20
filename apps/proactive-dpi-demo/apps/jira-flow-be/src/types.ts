// The domain of the Jira flow. A ticket is the unit of work; it moves through a lane's stages,
// shown in the flow UI, and ends in a GitLab MR. Jira gets one comment: the fix and the MR link.

/** Jira priority, highest first. The poller schedules in this order. */
export type Priority = "Highest" | "High" | "Medium" | "Low" | "Lowest";

export const PRIORITY_ORDER: Record<Priority, number> = {
  Highest: 0,
  High: 1,
  Medium: 2,
  Low: 3,
  Lowest: 4,
};

/** One issue as the poller sees it, straight from the jira CLI. */
export type JiraIssue = {
  key: string;
  project: string;
  summary: string;
  priority: Priority;
  status: string;
  created: string;
  updatedAt: string;
  labels: string[];
  reporter: string | null;
  description: string;
};

/** Kev's read on an unstarted ticket: which lane, how complex, start or clarify. */
export type Lane = "question" | "quick" | "ticket" | "feature";
export type Tier = "SIMPLE" | "MODERATE" | "COMPLEX";
export type Decision = "ready" | "needs_clarification" | "skip";

export type Classification = {
  lane: Lane;
  tier: Tier;
  decision: Decision;
  reason: string;
  probabilities?: Record<string, number>;
  model?: string;
  latencyMs?: number;
  cost?: number | null;
};

/** The stages a ticket walks. Which ones, and in which order, depends on its lane (see lanes.ts). */
export type Stage =
  | "discovered" // polled + classified, not yet started
  | "starting" // agent created, worktree being prepared (clone/checkout)
  | "classify" // worktree ready, agent reading the ticket
  | "grill" // interactive in the session: the engineer sharpens the scope (waits for a human)
  | "implement"
  | "review" // an independent reviewer checks the branch
  | "mr_open"
  | "approval" // auto-merge only: waiting for an approval to merge
  | "merged"
  | "answered" // lane question: answered in the session, no code
  | "blocked";

/** What the lane makes of a ticket, fixed when it starts. */
export type Plan = {
  grill: boolean;
  review: boolean;
  /** The stepper the UI shows, in order. */
  steps: Stage[];
};

/** The scope the engineer confirmed at the end of the grill. The Jira ticket stays the spec; this sharpens it. */
export type Scope = { summary: string; acceptance: string[]; confirmedAt: number };

/** How bad a review finding is. Judged by the reviewer, who has the code in front of it (see review-policy.ts). */
export type Severity = "blocking" | "risk" | "minor";
export type Finding = { severity: Severity; location: string; statement: string };
export type GateRun = { command: string; result: "pass" | "fail" | "not_run"; note?: string };
/** Derived in code from the findings and gates, never chosen by the reviewer. */
export type Verdict = "pass" | "pass_with_risks" | "changes_requested";

/** The latest independent review of the ticket's branch. */
export type ReviewState = {
  round: number;
  /** Try within the current review cycle; a rework after an open MR starts a new cycle. Older records lack it. */
  attempt?: number;
  verdict: "pending" | Verdict;
  findings: string;
  /** pass_with_risks: what the MR lists under "Open risks". */
  risks?: Finding[];
  minor?: Finding[];
  commit: string;
  reviewerConversationId: number | null;
  at: number;
};

/** One review round: requested by the coder, run by a reviewer conversation, delivered back to the coder. */
export type Review = {
  id: string; // `${ticketKey}#${round}`
  ticketKey: string;
  round: number;
  /** Try within the current review cycle (maxReviewRounds counts these). Older records lack it: use round. */
  attempt?: number;
  commit: string;
  coderConversationId: number;
  reviewerConversationId: number | null;
  status: "pending" | "done";
  verdict: Verdict | null;
  /** Rendered findings and gates (text), as the agent and the ticket card show them. */
  findings: string;
  gates: string;
  items?: Finding[];
  gateRuns?: GateRun[];
  requestedAt: number;
  finishedAt: number | null;
};

/** Where a ticket's code lives, resolved from the project mapping. */
export type RepoTarget = {
  host: string;
  /** group/project path on GitLab. */
  repo: string;
  /** Remote URL to clone (ssh by default). */
  remote: string;
  defaultBranch: string;
  /** Local base checkout path and the per-ticket worktree path. */
  base: string;
  worktree: string;
  branch: string;
};

/** The flow's record for one ticket. Lives in a durable document. */
export type Ticket = {
  key: string;
  project: string;
  title: string;
  description: string;
  priority: Priority;
  jiraStatus: string;
  labels: string[];
  classification: Classification | null;
  stage: Stage;
  /** Set once the agent is running. */
  conversationId: number | null;
  repo: RepoTarget | null;
  summary: string;
  discoveredAt: number;
  startedAt: number | null;
  updatedAt: number;
  timeline: { at: number; stage: Stage; summary: string }[];
  /** Set when the agent starts (optional: records from before lanes lack them). */
  lane?: Lane | null;
  plan?: Plan | null;
  scope?: Scope | null;
  review?: ReviewState | null;
  report: {
    branch: string | null;
    commit: string | null;
    diffStat: string | null;
    mrUrl: string | null;
    mrIid: number | null;
    /** The open_mr summary of the first MR; a rework adds its own line below it. */
    mrSummary?: string | null;
  };
};

export type MergeStatus =
  | "awaiting_approval"
  | "declined"
  | "merging"
  | "merged"
  | "failed"
  | "cancelled";

/** One merge request the agent opened and is waiting to get approved. */
export type Merge = {
  id: number;
  toolTaskId: number;
  ticketKey: string;
  conversationId: number;
  branch: string;
  commit: string;
  summary: string;
  diffStat: string;
  mrUrl: string | null;
  mrIid: number | null;
  status: MergeStatus;
  /** Which channel approved it, for the audit trail. */
  approvedVia: "gitlab" | "jira" | null;
  requestedAt: number;
  decidedAt: number | null;
  note: string | null;
};
