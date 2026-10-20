// The proactive part: poll Jira for labelled tickets, classify each new one with Kev, and surface
// it to the UI. Starting an agent is a separate, (by default) manual step — see the orchestrator.
import { EventEmitter } from "node:events";
import { config, pollJql } from "./config.ts";
import { Classifier } from "./classify.ts";
import { Jira } from "./jira.ts";
import { resolveRepo } from "./mapping.ts";
import { PRIORITY_ORDER, type JiraIssue, type Ticket } from "./types.ts";

/** A discovered ticket the orchestrator has not yet turned into a durable record. */
export type Discovery = {
  issue: JiraIssue;
  ticket: Ticket;
};

export class Poller extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private polling = false;
  /** Keys we have already discovered/classified this process, so we classify once. */
  private readonly seen = new Set<string>();
  /** When the last successful Jira poll finished; the UI's countdown ring starts from it. */
  lastPolledAt: number | null = null;

  constructor(
    private readonly jira: Jira,
    private readonly classifier: Classifier,
    /** The orchestrator tells the poller which keys already have a durable record (after recover). */
    private readonly isTracked: (key: string) => boolean,
    private readonly onDiscovered: (discovery: Discovery) => void,
  ) {
    super();
  }

  get judge() {
    return this.classifier.provider;
  }

  /** Mark keys the orchestrator already owns so a restart does not re-discover them. */
  prime(keys: Iterable<string>) {
    for (const k of keys) this.seen.add(k);
  }

  start() {
    this.timer = setInterval(() => void this.poll(), config.pollIntervalSec * 1000);
    void this.poll();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const issues = await this.jira.list(pollJql());
      // Highest priority first, then oldest first — the schedule the UI and optional auto-start use.
      issues.sort(
        (a, b) =>
          PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
          Date.parse(a.created) - Date.parse(b.created),
      );
      this.lastPolledAt = Date.now();
      this.emit("polled", { count: issues.length, at: this.lastPolledAt });
      for (const issue of issues) {
        if (this.seen.has(issue.key) || this.isTracked(issue.key)) continue;
        this.seen.add(issue.key);
        await this.discover(issue);
      }
    } catch (e) {
      this.emit("error", e);
      console.error("[poller]", e instanceof Error ? e.message : e);
    } finally {
      this.polling = false;
    }
  }

  private async discover(issue: JiraIssue) {
    const classification = await this.classifier.classify(issue);
    const repo = resolveRepo(issue);
    const now = Date.now();
    const ticket: Ticket = {
      key: issue.key,
      project: issue.project,
      title: issue.summary,
      description: issue.description,
      priority: issue.priority,
      jiraStatus: issue.status,
      labels: issue.labels,
      classification,
      stage: "discovered",
      conversationId: null,
      repo,
      summary: repo
        ? classification.reason
        : `No repo mapping for project ${issue.project}. Add it to jira-flow.config.json.`,
      discoveredAt: now,
      startedAt: null,
      updatedAt: now,
      timeline: [{ at: now, stage: "discovered", summary: classification.reason }],
      report: { branch: null, commit: null, diffStat: null, mrUrl: null, mrIid: null },
    };
    this.onDiscovered({ issue, ticket });
    this.emit("ticket", ticket);
  }
}
