// Run: npx tsx --test apps/jira-flow-be/src/review-policy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeReview, mrDescription } from "./review-policy.ts";
import type { Finding, GateRun } from "./types.ts";

const race: Finding = {
  severity: "risk",
  location: "checkout/Profile.ts:593",
  statement: "The login handler re-sends the profile without the new fields; a late response overwrites the cart and the fix is lost.",
};
const minor: Finding = { severity: "minor", location: "checkout/Profile.ts:538", statement: "Extra request." };
const green: GateRun[] = [{ command: "npm run test", result: "pass" }];

test("a risk goes back to the agent first (a race the fix depends on)", () => {
  const j = judgeReview([race, minor], green, 1, 2);
  assert.equal(j.verdict, "changes_requested");
  assert.equal(j.blocked, false);
  assert.deepEqual(j.risks, [race]);
});

test("a risk still there after the last try: MR as draft with open risks, not blocked", () => {
  const j = judgeReview([race], green, 2, 2);
  assert.equal(j.verdict, "pass_with_risks");
  assert.equal(j.blocked, false);
  assert.deepEqual(j.risks, [race]);
});

test("gates that could not run are an open risk, never a clean pass (a review that ran no tests)", () => {
  const j = judgeReview([], [{ command: "npm run test", result: "not_run", note: "no node_modules" }], 1, 2);
  assert.equal(j.verdict, "pass_with_risks");
  assert.match(j.risks[0].statement, /could not run/);
  assert.equal(judgeReview([], [], 1, 2).verdict, "pass_with_risks");
});

test("blocking findings and failing gates block after the last try", () => {
  const blocking: Finding = { severity: "blocking", location: "a.ts:1", statement: "AC-1 unmet." };
  assert.deepEqual(
    [judgeReview([blocking], green, 1, 2).verdict, judgeReview([blocking], green, 1, 2).blocked],
    ["changes_requested", false],
  );
  assert.equal(judgeReview([blocking], green, 2, 2).blocked, true);
  const failing = judgeReview([], [{ command: "npm run lint", result: "fail" }], 2, 2);
  assert.deepEqual([failing.verdict, failing.blocked, failing.blocking[0].location], ["changes_requested", true, "npm run lint"]);
});

test("minor findings only: a clean pass", () => {
  const j = judgeReview([minor], green, 1, 2);
  assert.deepEqual([j.verdict, j.minor], ["pass", [minor]]);
});

test("the MR description puts open risks first", () => {
  const text = mrDescription({
    ticketKey: "PROJ-123",
    summary: "Save the company fields after registration.",
    rework: "Reload the cart only for new customers.",
    acceptance: [],
    risks: [race],
    minor: [],
    reviewRound: 3,
    diffStat: "1 file changed",
  });
  assert.ok(text.startsWith("## ⚠ Open risks"));
  assert.match(text, /Latest rework: Reload the cart/);
  assert.match(text, /passed with 1 open risk\./);
});
