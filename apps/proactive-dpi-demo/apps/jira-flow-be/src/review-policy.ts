// What a review means for the flow. The reviewer (Opus, with the code in front of it) classifies each finding and
// reports each gate; this module — not the model — derives the verdict, and from it whether the MR is draft.
//
//   blocking, or a failing gate     → back to the agent; still there after the last try → ticket blocked
//   risk                            → back to the agent: fix it or disprove it with a test; still there after the
//                                     last try → MR as draft, listed under "Open risks", the engineer decides
//   a gate not run (or none at all) → the agent cannot fix the environment: straight to "Open risks"
//   minor only                      → pass, listed in the MR description
//
// The MR is ready only while its head passed review with no open risk and no rework is in progress.
import type { Finding, GateRun, Verdict } from "./types.ts";

export type Judgement = {
  verdict: Verdict;
  /** changes_requested on the last try: the ticket waits for the engineer. */
  blocked: boolean;
  blocking: Finding[];
  /** Risks the agent should fix or disprove (changes_requested), or the open ones the MR lists (pass_with_risks). */
  risks: Finding[];
  minor: Finding[];
};

export function judgeReview(items: Finding[], gates: GateRun[], attempt: number, maxAttempts: number): Judgement {
  const last = attempt >= maxAttempts;
  const blocking = [
    ...items.filter((f) => f.severity === "blocking"),
    ...gates
      .filter((g) => g.result === "fail")
      .map((g): Finding => ({ severity: "blocking", location: g.command, statement: `Gate fails${g.note ? `: ${g.note}` : "."}` })),
  ];
  const risks = items.filter((f) => f.severity === "risk");
  const unverified: Finding[] = gates.length
    ? gates
        .filter((g) => g.result === "not_run")
        .map((g) => ({ severity: "risk", location: g.command, statement: `Not verified: the gate could not run${g.note ? ` (${g.note})` : ""}.` }))
    : [{ severity: "risk", location: "gates", statement: "Not verified: the reviewer ran no gate." }];
  const minor = items.filter((f) => f.severity === "minor");

  if (blocking.length) return { verdict: "changes_requested", blocked: last, blocking, risks, minor };
  if (risks.length && !last) return { verdict: "changes_requested", blocked: false, blocking, risks, minor };
  const open = [...risks, ...unverified];
  return { verdict: open.length ? "pass_with_risks" : "pass", blocked: false, blocking, risks: open, minor };
}

const line = (f: Finding) => `- \`${f.location}\` — ${f.statement}`;

/** Findings as text, blocking first: for the agent, the ticket card and the timeline. */
export function renderFindings(j: Pick<Judgement, "blocking" | "risks" | "minor">, gates: GateRun[]): string {
  const sections = [
    j.blocking.length ? `BLOCKING\n${j.blocking.map(line).join("\n")}` : "",
    j.risks.length ? `RISK\n${j.risks.map(line).join("\n")}` : "",
    j.minor.length ? `MINOR\n${j.minor.map(line).join("\n")}` : "",
    `GATES\n${gates.length ? gates.map((g) => `- ${g.command} → ${g.result}${g.note ? ` (${g.note})` : ""}`).join("\n") : "- none run"}`,
  ];
  return sections.filter(Boolean).join("\n\n");
}

/** The MR description: open risks on top (they are why it is a draft), then what it ships. */
export function mrDescription(opts: {
  ticketKey: string;
  summary: string;
  rework: string | null;
  acceptance: string[];
  risks: Finding[];
  minor: Finding[];
  reviewRound: number | null;
  diffStat: string;
}): string {
  return [
    opts.risks.length
      ? `## ⚠ Open risks\nThe independent review passed, but these remain. This MR stays a draft until someone decides: ask the agent for a fix, or accept the risk and mark it ready.\n\n${opts.risks.map(line).join("\n")}`
      : "",
    `Closes ${opts.ticketKey}.\n\n${opts.summary}`,
    opts.rework ? `Latest rework: ${opts.rework}` : "",
    opts.acceptance.length ? `Acceptance criteria:\n${opts.acceptance.map((a, i) => `- AC-${i + 1}: ${a}`).join("\n")}` : "",
    opts.minor.length ? `Minor review notes:\n${opts.minor.map(line).join("\n")}` : "",
    opts.reviewRound ? `Independent review: round ${opts.reviewRound}, ${opts.risks.length ? `passed with ${opts.risks.length} open risk${opts.risks.length === 1 ? "" : "s"}` : "passed"}.` : "",
    `\`\`\`\n${opts.diffStat}\n\`\`\``,
  ]
    .filter(Boolean)
    .join("\n\n");
}
