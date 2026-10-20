// Kev decides the lane, the complexity tier, and whether a ticket is ready or needs clarification.
// If no judge is configured it degrades to a cheap heuristic so the flow still runs.
import { Jev, type Question } from "./judge.ts";
import type { Classification, JiraIssue, Lane, Tier } from "./types.ts";

const QUESTIONS: Record<string, Question> = {
  lane: {
    type: "choice",
    instructions:
      "You route incoming engineering tickets to the cheapest lane that fits. Read this ticket and pick the lane.",
    criteria: {
      question: "A question or investigation, no change to the code is asked for.",
      quick: "A small, scoped change in a named place: a typo, a dependency bump, a null check.",
      ticket: "A clear, bounded task with enough detail to implement directly.",
      feature: "A new capability that is vague or large and needs its scope sharpened first.",
    },
  },
  tier: {
    type: "choice",
    instructions: "Judge how much model capability this ticket needs to implement safely.",
    criteria: {
      SIMPLE: "Trivial, low-risk, a few lines in one place.",
      MODERATE: "A normal bounded change across a file or two.",
      COMPLEX: "Risky, cross-cutting, architectural, or underspecified. When unsure, choose this.",
    },
  },
  readiness: {
    type: "choice",
    instructions: "Decide whether an agent can start now or must first clarify scope with a human.",
    criteria: {
      ready: "The description is concrete enough to begin implementing or investigating.",
      needs_clarification: "Too vague to start; a human must sharpen the scope first.",
    },
  },
};

function heuristic(issue: JiraIssue): Classification {
  const text = `${issue.summary}\n${issue.description}`;
  const big = /\b(refactor|architecture|migrat|redesign|rework|multi-currency|rewrite)\b/i.test(text);
  const tiny = issue.description.length < 300 && issue.summary.length < 80;
  const tier: Tier = big ? "COMPLEX" : tiny ? "SIMPLE" : "MODERATE";
  const lane: Lane = big ? "feature" : tiny ? "quick" : "ticket";
  const vague = issue.description.trim().length < 40;
  return {
    lane,
    tier,
    decision: vague ? "needs_clarification" : "ready",
    reason: vague
      ? "Heuristic: description too short to start."
      : `Heuristic: ${tier.toLowerCase()} ${lane}.`,
  };
}

export class Classifier {
  private readonly jev?: Jev;
  readonly provider: string;

  constructor() {
    try {
      this.jev = new Jev();
      this.provider = this.jev.provider;
    } catch {
      this.provider = "heuristic (no judge configured)";
    }
  }

  async classify(issue: JiraIssue): Promise<Classification> {
    if (!this.jev) return heuristic(issue);
    try {
      const state = {
        key: issue.key,
        summary: issue.summary,
        description: issue.description.slice(0, 4000),
        priority: issue.priority,
        labels: issue.labels,
      };
      const r = await this.jev.ask(state, QUESTIONS);
      const lane = (r.answers.lane as { choice: Lane }).choice;
      const tier = (r.answers.tier as { choice: Tier }).choice;
      const readiness = (r.answers.readiness as { choice: string }).choice;
      return {
        lane,
        tier,
        decision: readiness === "needs_clarification" ? "needs_clarification" : "ready",
        reason: `Kev: ${tier.toLowerCase()} ${lane}, ${readiness}.`,
        probabilities: (r.answers.lane as { probabilities?: Record<string, number> }).probabilities,
        model: r.model,
        latencyMs: r.latencyMs,
        cost: r.cost,
      };
    } catch (e) {
      const h = heuristic(issue);
      h.reason = `Judge failed (${e instanceof Error ? e.message : e}); ${h.reason}`;
      return h;
    }
  }
}
