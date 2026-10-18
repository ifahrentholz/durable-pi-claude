// Tool approvals (this fork): calls wait for a person, rules skip the question, decisions survive a restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { APPROVALS_DOC, ruleAllows, suggestRule, type ApprovalsDoc } from "../../dpi-sdk/src/approvals.js";
import type { Store } from "../src/store.js";
import { faux, tempStore, until } from "./helpers.js";

test("rules: prefix rules match simple commands only, exact rules match exactly", () => {
  assert.ok(ruleAllows("Bash(jira issue view:*)", "bash", { command: "jira issue view VAU-1 --plain" }));
  assert.ok(ruleAllows("Bash(git status:*)", "bash", { command: "git status" }));
  assert.ok(!ruleAllows("Bash(git status:*)", "bash", { command: "git status && rm -rf /" }), "no chaining past a prefix rule");
  assert.ok(!ruleAllows("Bash(git status:*)", "bash", { command: "git statusx" }));
  assert.ok(ruleAllows("Bash(ls | wc -l)", "bash", { command: "ls | wc -l" }));
  assert.ok(ruleAllows("edit", "edit", { path: "a.ts" }));
  assert.ok(!ruleAllows("edit", "write", { path: "a.ts" }));
  assert.equal(suggestRule("bash", { command: "mvn test -q" }), "Bash(mvn test:*)");
  assert.equal(suggestRule("bash", { command: "ls | wc -l" }), "Bash(ls | wc -l)");
  assert.equal(suggestRule("write", { path: "x" }), "write");
});

test("approvals: bash waits for a decision; allow runs it, deny blocks it, always adds a rule; restart keeps the request", async () => {
  const t = await tempStore();
  let store: Store = await t.open();
  try {
    const session = await store.create({ name: "Approvals", cwd: t.work, model: faux });
    let { row, h, c } = await store.resolveAgent(session.id, "main");
    await store.setExtension(row, c, { name: "approvals", enabled: true });
    const pending = async () =>
      Object.values(((await store.agentDoc(h, c, APPROVALS_DOC)) as ApprovalsDoc).items ?? {}).filter((i) => i.status === "pending");

    // Allow once: the command runs after the decision.
    const first = await store.send(c, { content: "!touch allowed.txt", requestId: "a1" });
    await until(async () => (await pending()).length === 1, 15000, "a pending approval");
    assert.ok(!existsSync(join(t.work, "allowed.txt")), "nothing runs before the decision");
    const [item] = await pending();
    assert.equal(item.summary, "touch allowed.txt");
    assert.equal((await store.agents(row)).find((a) => a.id === 1)?.approvals, 1, "the tree counts open requests");
    await store.decideTool(c, item.callId, { decision: "allow" });
    assert.equal((await store.settled(h, first.id as number, 20000)).status, "done");
    assert.ok(existsSync(join(t.work, "allowed.txt")));

    // Deny with a note: the call is blocked and the agent sees the note.
    const second = await store.send(c, { content: "!touch denied.txt", requestId: "a2" });
    await until(async () => (await pending()).length === 1, 15000, "a second pending approval");
    await store.decideTool(c, (await pending())[0].callId, { decision: "deny", message: "use the scratch dir" });
    assert.equal((await store.settled(h, second.id as number, 20000)).status, "done");
    assert.ok(!existsSync(join(t.work, "denied.txt")));
    assert.match(JSON.stringify((await store.entries(c, undefined, 5)).items), /use the scratch dir/);

    // A default rule skips the question.
    const third = await store.send(c, { content: "!git status", requestId: "a3" });
    assert.equal((await store.settled(h, third.id as number, 20000)).status, "done");
    assert.equal((await pending()).length, 0);

    // A pending request survives a restart; deciding afterwards runs the call once.
    await store.send(c, { content: "!touch after-restart.txt", requestId: "a4" });
    await until(async () => (await pending()).length === 1, 15000, "a pending approval before restart");
    await store.close();
    store = await t.open();
    ({ row, h, c } = await store.resolveAgent(session.id, "main"));
    await until(async () => (await pending()).length === 1, 15000, "the request after restart");
    await store.decideTool(c, (await pending())[0].callId, { decision: "always" });
    await until(async () => existsSync(join(t.work, "after-restart.txt")), 20000, "the call after restart");
    assert.ok((await store.approvalRules(h)).allow.includes("Bash(touch after-restart.txt:*)"));

    // Always allow: the same command no longer asks.
    const fifth = await store.send(c, { content: "!touch after-restart.txt", requestId: "a5" });
    assert.equal((await store.settled(h, fifth.id as number, 20000)).status, "done");
    assert.equal((await pending()).length, 0);
    await assert.rejects(() => store.decideTool(c, "nope", { decision: "allow" }), /No pending approval/);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("approvals: a durable job's subagent asks too when its agent does", async () => {
  const t = await tempStore();
  const store: Store = await t.open();
  try {
    const session = await store.create({ name: "Job approvals", cwd: t.work, model: faux });
    const { row, h, c } = await store.resolveAgent(session.id, "main");
    await store.setExtension(row, c, { name: "approvals", enabled: true });
    const { taskId } = await store.startJob(row, h, c, { job: "release-check" });
    // The gather phase's subagent runs bash; it waits for a decision in the subagent's own conversation.
    let child: { approvals?: number; id: number } | undefined;
    await until(async () => !!(child = (await store.agents(row)).find((a) => a.kind === "subagent" && a.approvals)), 30000, "the subagent's request");
    const sub = await store.resolveAgent(session.id, String(child!.id));
    const items = Object.values(((await store.agentDoc(sub.h, sub.c, APPROVALS_DOC)) as ApprovalsDoc).items);
    assert.equal(items.length, 1);
    await store.decideTool(sub.c, items[0].callId, { decision: "allow" });
    const runs = async () => ((await store.agentDoc(h, c, "demo.job-runs")) as { items: Record<string, { approval?: string; status: string }> }).items[String(taskId)];
    await until(async () => (await runs())?.approval === "pending", 30000, "the job's own approval phase");
    await store.approveJob(c, taskId, true);
    await until(async () => (await runs())?.status === "completed", 30000, "the job to complete");
  } finally {
    await store.close();
    await t.cleanup();
  }
});
