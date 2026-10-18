// Session names from the first message (this fork).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionTitle, type Store } from "../src/store.js";
import { faux, tempStore } from "./helpers.js";

test("sessionTitle: first line, links shortened to their keys, at most 60 characters", () => {
  assert.equal(sessionTitle("fix https://diva-e.atlassian.net/browse/VAU-3197"), "fix VAU-3197");
  assert.equal(sessionTitle("Review https://gitlab.diva-e.com/conti/contitrade-aem/-/merge_requests/3305 please"), "Review !3305 please");
  assert.equal(sessionTitle("look at https://github.com/disler/durable-pi/pull/12"), "look at #12");
  assert.equal(sessionTitle("\n\n  Gib mir einen Überblick\nüber die Architektur"), "Gib mir einen Überblick");
  assert.equal(sessionTitle("read https://example.com/docs/setup.html?x=1"), "read setup.html");
  const long = sessionTitle("Gib mir einen Überblick über die Architektur des Projekts, Module, Build und Frontend bitte");
  assert.ok(long.length <= 60 && long.endsWith("…"), long);
});

test("autoName: a default-named session takes its first message's title once; a chosen name stays", async () => {
  const t = await tempStore();
  const store: Store = await t.open();
  try {
    const unnamed = await store.create({ name: "New session", cwd: t.work, model: faux });
    await store.autoName(store.row(unnamed.id), "fix https://diva-e.atlassian.net/browse/VAU-3197");
    assert.equal(store.row(unnamed.id).name, "fix VAU-3197");
    await store.autoName(store.row(unnamed.id), "second message");
    assert.equal(store.row(unnamed.id).name, "fix VAU-3197", "only the first message names it");
    const named = await store.create({ name: "Burger menu", cwd: t.work, model: faux });
    await store.autoName(store.row(named.id), "fix VAU-1");
    assert.equal(store.row(named.id).name, "Burger menu");
    // A session that already had messages (named before this feature) takes its first one, not the new one.
    const older = await store.create({ name: "New session", cwd: t.work, model: faux });
    const { h, c } = await store.resolveAgent(older.id, "main");
    const sent = await store.send(c, { content: "Explain the build", requestId: "o1" });
    await store.settled(h, sent.id as number, 20000);
    await store.autoName(store.row(older.id), "and the tests?");
    assert.equal(store.row(older.id).name, "Explain the build");
  } finally {
    await store.close();
    await t.cleanup();
  }
});
