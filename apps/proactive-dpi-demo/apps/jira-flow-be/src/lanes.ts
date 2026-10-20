// The lanes, after omnigent-radar's radar-lanes: Kev's classification picks the cheapest chain that fits, and the
// lane decides what the ticket agent does. Unlike radar, a polled ticket runs unattended, so the chain is
// batch-ahead: no "add review?" questions, the agent stops only where a human is really needed (grill, blocked).
//
//   question  answer in the session, no code               classify → answered
//   quick     small scoped change                          classify → implement → review* → mr_open
//   ticket    clear bounded task                           classify → implement → review → mr_open
//   feature   vague or large, scope first                  classify → grill → implement → review → mr_open
//
// needs_clarification sends any code lane through the grill first. *review in quick: config.reviewQuick.
// The Jira ticket is the spec; the grill sharpens it in the session into a confirmed scope with acceptance criteria.
import { config } from "./config.ts";
import type { Decision, Lane, Plan, Review, Stage, Ticket } from "./types.ts";

export const LANES: Lane[] = ["question", "quick", "ticket", "feature"];

export function planFor(lane: Lane, decision: Decision | undefined): Plan {
  if (lane === "question") return { grill: false, review: false, steps: ["classify", "answered"] };
  const grill = lane === "feature" || decision === "needs_clarification";
  const review = lane !== "quick" || config.reviewQuick;
  const steps: Stage[] = ["classify"];
  if (grill) steps.push("grill");
  steps.push("implement");
  if (review) steps.push("review");
  steps.push("mr_open");
  if (config.autoMerge) steps.push("approval", "merged");
  return { grill, review, steps };
}

/** The lane-specific part of the ticket agent's instructions (the generic rules are the ticket_playbook section). */
export function playbook(ticket: Ticket, lane: Lane, plan: Plan): string {
  const own = `You own ${ticket.key}: ${ticket.title}. Your worktree is ${ticket.repo!.worktree} on branch ${ticket.repo!.branch}.`;
  if (lane === "question")
    return `${own}

Lane: QUESTION. The ticket asks for an answer, not a code change.
1. Investigate: read the code, run read-only commands. Do not edit files, do not commit, no MR.
2. Answer the engineer here in the session, with the evidence as file:line.
3. Call answer_question with a one-line summary. You are done.`;

  const steps: string[] = [];
  if (plan.grill)
    steps.push(`Grill. The ticket is the spec, but it is not sharp enough to implement. Interview the engineer here in the session until you share one understanding of the scope:
   - One question at a time, each with your recommended answer. Wait for the reply before the next one.
   - Walk the decision tree branch by branch, resolving dependencies between decisions one by one.
   - A fact you can find in the code or the environment, look up yourself. Decisions are the engineer's: ask.
   - When nothing is open, state the scope and numbered acceptance criteria and ask the engineer to confirm. Each criterion one behaviour, falsifiable.
   - Only after an explicit yes: confirm_scope with that summary and those criteria. Never call it on your own judgement.`);
  steps.push(`Implement. update_ticket "implement"${plan.grill ? " (confirm_scope already did this)" : ""}, then the smallest correct change plus a test where it makes sense.${plan.grill ? " Work against the confirmed acceptance criteria." : ""}`);
  steps.push(`Submit. submit_fix with a one-line summary and a commit message "<type>(<area>): <what> (${ticket.key})". It commits on your branch and runs the project's test command if one is configured.`);
  if (plan.review)
    steps.push(`Review. request_review, then end your turn. An independent reviewer checks the branch against the ticket${plan.grill ? " and the acceptance criteria" : ""} and re-runs the gates; you never see its reasoning, only its findings, which arrive as your next message. Blocking findings and risks come back to you: fix them, or disprove a risk with a test. After ${config.maxReviewRounds} tries, blocking findings block the ticket for the engineer; risks that remain go into the MR, which then stays a draft for the engineer's decision.`);
  steps.push(`Open MR. open_mr with one short sentence on what was fixed. It pushes and opens the GitLab MR against ${ticket.repo!.defaultBranch}; that sentence and the MR link become the only comment on the Jira ticket. ${config.autoMerge ? "It then waits for approval and merges." : "A human approves and merges. You are done once it is open: report the URL and stop."}`);
  if (!config.autoMerge)
    steps.push(`Rework. If the engineer asks for a change after the MR is open: make it, then submit_fix — that moves the ticket back to implement.${plan.review ? " Then request_review as before; the new commit needs its own passed review." : ""} Then open_mr again: it pushes to the same MR and writes no second Jira comment.`);

  return `${own}

Lane: ${lane.toUpperCase()}.${plan.grill ? " Starts with a grill session." : ""}
${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
}

/** The reviewer's first message. Branch, ticket, criteria and gates — never the coder's report or reasoning. */
export function reviewBrief(ticket: Ticket, review: Review, testCommand: string | null): string {
  const repo = ticket.repo!;
  const acceptance = ticket.scope?.acceptance.length
    ? ticket.scope.acceptance.map((a, i) => `AC-${i + 1}: ${a}`).join("\n")
    : "none stated (judge against the ticket description)";
  return `## Task
Review round ${review.round} of ${ticket.key} on branch ${repo.branch} (commit ${review.commit}) against ${repo.defaultBranch}.

## Ticket (the spec)
${ticket.title}

${ticket.description || "(no description)"}
${ticket.scope ? `\nConfirmed scope: ${ticket.scope.summary}\n` : ""}
## Acceptance
${acceptance}

## Context
Worktree: ${repo.worktree}
Diff: git diff origin/${repo.defaultBranch}...HEAD   Commits: git log origin/${repo.defaultBranch}..HEAD
Gates: ${testCommand ? `${testCommand} (configured), plus whatever the project's manifest or CI runs` : "find them yourself in the project's manifest, Makefile or CI config"}

## Return
Call submit_review once, at the end.`;
}

/** What the coder receives when a review round is done. The findings text comes from review-policy.renderFindings. */
export function reviewResult(review: Review, blocked: boolean): string {
  const label = { pass: "PASS", pass_with_risks: "PASS WITH OPEN RISKS", changes_requested: "CHANGES REQUESTED" }[review.verdict ?? "changes_requested"];
  const head = `Review round ${review.round}: ${label}.`;
  const body = review.findings.trim() || "(no findings)";
  if (review.verdict === "pass") return `${head}\n\n${body}\n\nNow open_mr.`;
  if (review.verdict === "pass_with_risks")
    return `${head}\n\n${body}\n\nThe risks above stay open. Now open_mr: the MR becomes a draft that lists them, and the engineer decides.`;
  if (blocked)
    return `${head}\n\n${body}\n\nThat was the last review try; the ticket is blocked for the engineer. Do not change anything now: wait for the engineer's instructions here.`;
  return `${head}\n\n${body}\n\nOn the same branch: fix every BLOCKING finding. For every RISK, fix it, or disprove it with a test that exercises exactly that scenario; if you can do neither, say why in one line. MINOR where cheap. Then submit_fix and request_review again.`;
}
