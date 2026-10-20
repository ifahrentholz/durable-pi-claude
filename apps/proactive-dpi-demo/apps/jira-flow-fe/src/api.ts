export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    `/api${path}`,
    body === undefined
      ? {}
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  const data = await res.json();
  if (!res.ok) throw Error(data.error ?? "Request failed");
  return data;
}

/** Stage labels for the stepper and the agent card. */
export const STAGE_LABELS: Record<string, string> = {
  discovered: "Discovered",
  starting: "Setting up",
  classify: "Classified",
  grill: "Grill",
  implement: "Implementing",
  review: "Review",
  mr_open: "MR open",
  approval: "Approval",
  merged: "Merged",
  answered: "Answered",
  blocked: "Blocked",
};

/** The stage stepper for tickets started before lanes (newer ones carry their own in ticket.plan.steps). */
export const STAGE_STEPS = ["classify", "implement", "review", "mr_open", "approval", "merged"];

/** Kev's lanes, after omnigent-radar. */
export const LANE_LABELS: Record<string, string> = {
  question: "Question",
  quick: "Quick",
  ticket: "Ticket",
  feature: "Feature",
};
export const LANE_HINTS: Record<string, string> = {
  question: "Answer in the session, no code, no MR.",
  quick: "Small scoped change: implement → MR.",
  ticket: "Clear task: implement → independent review → MR.",
  feature: "Vague or large: grill session first, then implement → review → MR.",
};

/** Kev's decision on an unstarted ticket, shown as the feed chip. */
export const DECISION_LABELS: Record<string, string> = {
  ready: "Ready to Start",
  needs_clarification: "Needs Clarification",
  skip: "Skipped",
};

/** An open MR whose review left risks: a draft waiting for the engineer's decision. */
export function needsDecision(ticket: { stage: string; review?: { verdict: string } | null }): boolean {
  return ticket.stage === "mr_open" && ticket.review?.verdict === "pass_with_risks";
}

/** The chip shown in the feed per ticket: its live stage, or Kev's decision while unstarted. */
export function feedChip(ticket: {
  stage: string;
  conversationId: number | null;
  classification: { decision: string } | null;
  review?: { verdict: string } | null;
}): string {
  if (needsDecision(ticket)) return "Decision needed";
  if (ticket.stage === "discovered")
    return DECISION_LABELS[ticket.classification?.decision ?? ""] ?? "Discovered";
  return STAGE_LABELS[ticket.stage] ?? ticket.stage;
}

/** Colour class for a ticket's chip, matching the style.css status colours. */
export function chipClass(ticket: {
  stage: string;
  classification: { decision: string } | null;
  review?: { verdict: string } | null;
}): string {
  if (needsDecision(ticket)) return "clar";
  if (["merged", "answered"].includes(ticket.stage)) return "merged";
  if (ticket.stage === "blocked") return "blocked";
  if (["grill", "mr_open", "approval"].includes(ticket.stage)) return "waiting";
  if (["starting", "implement", "review", "classify"].includes(ticket.stage)) return "progress";
  if (ticket.classification?.decision === "needs_clarification") return "clar";
  return "ready";
}

export const PRIORITY_RANK: Record<string, number> = {
  Highest: 0,
  High: 1,
  Medium: 2,
  Low: 3,
  Lowest: 4,
};
