// Deleting agents from a session (this fork): the agent, its forks and the subagents it owns leave the session.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Store } from "../src/store.js";
import { faux, tempStore } from "./helpers.js";

test("remove agent: the agent and its forks leave the session; Main stays; removed agents cannot be addressed", async () => {
  const t = await tempStore();
  const store: Store = await t.open();
  try {
    const session = await store.create({ name: "Cleanup", cwd: t.work, model: faux });
    const row = store.row(session.id);
    const { h, c: main } = await store.resolveAgent(session.id, "main");
    const sent = await store.send(main, { content: "hello", requestId: "r1" });
    await store.settled(h, sent.id as number, 20000);
    const entry = (await store.entries(main, undefined, 10)).items.find((e) => e.kind === "pi.assistant")!;

    const other = await store.createAgent(row, { name: "Side quest" });
    const { c: side } = await store.resolveAgent(session.id, String(other.id));
    const sideSent = await store.send(side, { content: "hi", requestId: "r2" });
    await store.settled(h, sideSent.id as number, 20000);
    const sideEntry = (await store.entries(side, undefined, 10)).items.find((e) => e.kind === "pi.assistant")!;
    const fork = await store.fork(row, side, { entryId: sideEntry.id, name: "Side fork" });
    const keep = await store.fork(row, main, { entryId: entry.id, name: "Main fork" });

    const names = async () => (await store.agents(row)).map((a) => a.name).sort();
    assert.deepEqual(await names(), ["Main", "Main fork", "Side fork", "Side quest"]);

    const result = await store.removeAgent(row, side);
    assert.deepEqual(result.removed.sort(), [other.id, fork.id].sort(), "a fork goes with the agent it was forked from");
    assert.deepEqual(await names(), ["Main", "Main fork"]);
    await assert.rejects(() => store.resolveAgent(session.id, String(other.id)), /was removed/);
    await assert.rejects(() => store.resolveAgent(session.id, "Side quest"), /No agent/);
    await assert.rejects(() => store.removeAgent(row, main), /Main cannot be removed/);
    assert.equal((await store.agents(row)).find((a) => a.id === keep.id)?.name, "Main fork");

    // Survives a restart.
    await store.close();
    const again: Store = await t.open();
    try {
      assert.deepEqual((await again.agents(again.row(session.id))).map((a) => a.name).sort(), ["Main", "Main fork"]);
    } finally {
      await again.close();
    }
  } finally {
    await store.close().catch(() => {});
    await t.cleanup();
  }
});
