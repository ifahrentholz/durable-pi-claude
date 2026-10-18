// Project context (this fork): which instruction files an agent's folder gets, with @imports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFiles, renderProject } from "../src/project-context.js";

test("project context: user file, repo root down to the folder, @imports once, nothing above the repo", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dpi-pc-")));
  try {
    const home = join(root, "home");
    const repo = join(home, "code", "repo");
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, ".claude"), { recursive: true });
    await mkdir(join(repo, "web", "src"), { recursive: true });
    await writeFile(join(home, ".claude", "CLAUDE.md"), "user rules");
    await writeFile(join(home, "code", "CLAUDE.md"), "above the repo: never read");
    await writeFile(join(repo, ".claude", "CLAUDE.md"), "repo rules\n\n@AGENTS.md\n\n`@not-an-import.md`\n");
    await writeFile(join(repo, ".claude", "AGENTS.md"), "agents guide, see @../docs/style.md");
    await mkdir(join(repo, "docs"));
    await writeFile(join(repo, "docs", "style.md"), "style guide");
    await writeFile(join(repo, "web", "AGENTS.md"), "web rules @../.claude/AGENTS.md");

    const files = projectFiles(join(repo, "web", "src"), home).map((f) => [f.path.slice(root.length), f.importedBy?.slice(root.length)]);
    assert.deepEqual(files, [
      ["/home/.claude/CLAUDE.md", undefined],
      ["/home/code/repo/.claude/CLAUDE.md", undefined],
      ["/home/code/repo/.claude/AGENTS.md", "/home/code/repo/.claude/CLAUDE.md"],
      ["/home/code/repo/docs/style.md", "/home/code/repo/.claude/AGENTS.md"],
      ["/home/code/repo/web/AGENTS.md", undefined],
    ]);
    const text = renderProject(join(repo, "web"), home)!;
    assert.match(text, /working folder ~\/code\/repo\/web/);
    assert.match(text, /<file path="~\/code\/repo\/.claude\/AGENTS.md" imported_by="~\/code\/repo\/.claude\/CLAUDE.md">/);
    assert.doesNotMatch(text, /never read/);
    assert.equal(renderProject(join(root, "empty-elsewhere"), join(root, "nohome")), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
