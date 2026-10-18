// Archived sessions (this fork): list, restore with names and deleted agents, older archives, delete for good.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import type { Store } from "../src/store.js";
import { faux, tempStore } from "./helpers.js";

test("archive: list, restore (name, agent names, deleted agents, history), older archives, delete for good", async () => {
  const t = await tempStore();
  const store: Store = await t.open();
  try {
    const project = join(t.work, "project");
    const s = await store.create({ name: "Burger menu", cwd: project, model: faux });
    const row = store.row(s.id);
    const { h, c } = await store.resolveAgent(s.id, "main");
    await store.settled(h, (await store.send(c, { content: "fix the burger menu", requestId: "a1" })).id as number, 20000);
    const side = await store.createAgent(row, { name: "Side" });
    const gone = await store.createAgent(row, { name: "Gone" });
    await store.removeAgent(row, (await store.resolveAgent(s.id, String(gone.id))).c);

    await store.archive(row);
    assert.equal(store.list().length, 0);
    let archives = await store.archives();
    assert.equal(archives.length, 1);
    assert.equal(archives[0].name, "Burger menu");
    assert.equal(archives[0].cwd, project);
    assert.ok(archives[0].bytes > 0);

    const restored = await store.restoreArchive(archives[0].dir);
    assert.equal(restored.name, "Burger menu");
    assert.equal(restored.cwd, project);
    assert.deepEqual(restored.agents.map((a) => a.name).sort(), ["Main", "Side"], "names kept, deleted agent stays deleted");
    assert.equal(restored.agents.find((a) => a.id === side.id)?.name, "Side");
    const { c: main } = await store.resolveAgent(s.id, "main");
    assert.match(JSON.stringify((await store.entries(main, undefined, 20)).items), /fix the burger menu/);
    assert.equal((await store.archives()).length, 0);
    await assert.rejects(() => store.restoreArchive("nonsense"), /Not an archived session/);

    // An archive from before session.json: named after its first message, folder from its root agent.
    await store.archive(store.row(s.id));
    archives = await store.archives();
    rmSync(join(t.options.dataDir, "archive", archives[0].dir, "session.json"));
    archives = await store.archives();
    assert.equal(archives[0].name, "");
    assert.equal(archives[0].firstMessage, "fix the burger menu");
    const old = await store.restoreArchive(archives[0].dir);
    assert.equal(old.name, "fix the burger menu");
    assert.equal(old.cwd, project);

    // Delete for good.
    await store.archive(store.row(s.id));
    archives = await store.archives();
    await store.deleteArchive(archives[0].dir);
    assert.equal((await store.archives()).length, 0);
    assert.ok(!existsSync(join(t.options.dataDir, "archive", archives[0].dir)));
  } finally {
    await store.close();
    await t.cleanup();
  }
});
