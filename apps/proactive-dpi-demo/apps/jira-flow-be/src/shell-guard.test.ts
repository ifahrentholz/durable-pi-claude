// Run: npx tsx --test apps/jira-flow-be/src/shell-guard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandsOf, reviewerBlock, ticketAgentBlock } from "./shell-guard.ts";

const WT = "/home/dev/durable-pi-claude/apps/proactive-dpi-demo/apps/jira-flow-be/.data/worktrees/PROJ-123";

test("splits a line into its commands and unfolds bash -c", () => {
  assert.deepEqual(
    commandsOf(`cd ${WT} && git log --oneline | head -5; echo "a && b" $(git status)`).map((c) => c.bin),
    ["cd", "git", "head", "echo", "git"],
  );
  assert.deepEqual(commandsOf(`bash -lc "git push origin x"`), [{ bin: "git", args: ["push", "origin", "x"] }]);
  assert.deepEqual(commandsOf(`FOO=1 sudo /usr/bin/git status 2>&1`), [{ bin: "git", args: ["status", "2>&1"] }]);
});

test("reviewer: reading the worktree under jira-flow-be is allowed (the reported failure)", () => {
  for (const line of [
    `git -C ${WT} log --stat origin/develop..HEAD`,
    `git -C ${WT} diff origin/develop...HEAD`,
    `ls ${WT}`,
    `cd ${WT} && npm test 2>&1 | tail -50`,
    `cd ${WT} && mvn -q verify > /dev/null`,
    `git -C ${WT} branch --show-current`,
    `git -C ${WT} show 2bfe63e209 --stat`,
    `grep -rn "jira" ${WT}/src | head`,
  ])
    assert.equal(reviewerBlock(line), null, line);
});

test("reviewer: changing the tree, refs, files or trackers is blocked", () => {
  for (const line of [
    `git -C ${WT} commit -am x`,
    `cd ${WT} && git checkout develop`,
    `git -C ${WT} stash`,
    `git fetch origin`,
    `git branch -D feature/PROJ-123`,
    `jira issue comment add PROJ-123 hi`,
    `glab mr approve 12`,
    `rm -rf ${WT}/target`,
    `sed -i 's/a/b/' ${WT}/x.ts`,
    `npx eslint --fix .`,
    `echo x > ${WT}/notes.md`,
    `bash -c "git reset --hard"`,
  ])
    assert.notEqual(reviewerBlock(line), null, line);
});

test("ticket agent: normal work is allowed, branch and MR operations are blocked", () => {
  for (const line of [
    `git -C ${WT} status`,
    `git add -A && git diff --cached`,
    `git checkout -- src/a.ts`,
    `glab mr view 12`,
    `rm -rf ${WT}/target`,
  ])
    assert.equal(ticketAgentBlock(line), null, line);
  for (const line of [
    `git push origin HEAD`,
    `git -C ${WT} checkout -b other`,
    `git checkout develop`,
    `git reset --hard origin/develop`,
    `cd x && glab mr create --fill`,
    `git worktree add ../y`,
  ])
    assert.notEqual(ticketAgentBlock(line), null, line);
});
