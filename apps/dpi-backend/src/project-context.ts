// Project context (this fork): the instructions Claude Code would read for the agent's folder, plus this device's
// developer-tool instructions, as system prompt sections. Re-read before every request, so an edited CLAUDE.md
// applies from the next one; pi-durable only sends a section again when its text changed.
//
//   project_instructions  ~/.claude/CLAUDE.md, then from the repository root down to the agent's folder:
//                         CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md, AGENTS.md, with @path imports resolved
//   developer_tools       prompts/developer-tools.md (jira, glab, gh) plus ~/.dpi/instructions.md when present
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";

export const PROJECT_CONTEXT_INFO = {
  name: "project-context",
  title: "Project context",
  description:
    "Adds the CLAUDE.md and AGENTS.md instructions of this agent's folder (and ~/.claude/CLAUDE.md, with @imports) plus the device's jira, glab and gh instructions to the system prompt. Re-read before every request.",
};

const PROJECT_FILES = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];
const MAX_FILE = 60_000;
const MAX_TOTAL = 200_000;
const MAX_IMPORT_DEPTH = 5;
const TOOLS_PROMPT = join(import.meta.dirname, "../prompts/developer-tools.md");

export type ContextFile = { path: string; text: string; importedBy?: string };

/** The instruction files for `cwd`, in the order Claude Code reads them: user, then repository root down to `cwd`. */
export function projectFiles(cwd: string, home = homedir()): ContextFile[] {
  const files: ContextFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  const add = (path: string, importedBy: string | undefined, depth: number) => {
    const real = resolve(path);
    if (seen.has(real) || !isFile(real) || total >= MAX_TOTAL) return;
    seen.add(real);
    let text = readFileSync(real, "utf8");
    if (text.length > MAX_FILE) text = `${text.slice(0, MAX_FILE)}\n… [truncated: ${text.length - MAX_FILE} more characters]`;
    total += text.length;
    files.push({ path: real, text, ...(importedBy ? { importedBy } : {}) });
    if (depth < MAX_IMPORT_DEPTH) for (const target of imports(text, dirname(real), home)) add(target, real, depth + 1);
  };
  add(join(home, ".claude", "CLAUDE.md"), undefined, 0);
  for (const dir of lineage(cwd, home)) for (const name of PROJECT_FILES) add(join(dir, name), undefined, 0);
  return files;
}

/** Folders from the repository root (or the home folder) down to `cwd`. */
function lineage(cwd: string, home: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    dirs.unshift(dir);
    if (existsSync(join(dir, ".git")) || dir === home) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** `@path` references outside code, resolved like Claude Code: relative to the file, `~/` from home. */
function imports(text: string, base: string, home: string): string[] {
  const found: string[] = [];
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const m of prose.matchAll(/(?:^|[\s(])@((?:~\/|\.{1,2}\/|\/)?[\w.\-/]+)/gm)) {
    const ref = m[1].replace(/[.,;:)]+$/, "");
    const path = ref.startsWith("~/") ? join(home, ref.slice(2)) : isAbsolute(ref) ? ref : join(base, ref);
    if (isFile(path)) found.push(path);
  }
  return found;
}

function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function renderProject(cwd: string, home = homedir()): string | undefined {
  const files = projectFiles(cwd, home);
  if (!files.length) return undefined;
  const label = (p: string) => (p.startsWith(home) ? `~/${relative(home, p)}` : p);
  return [
    `Instructions from the user's CLAUDE.md and AGENTS.md files for the working folder ${label(resolve(cwd))}. They are the user's own instructions for this project: follow them, they take precedence over general defaults. Files referenced with @path are included after the file that imports them.`,
    ...files.map((f) => `<file path="${label(f.path)}"${f.importedBy ? ` imported_by="${label(f.importedBy)}"` : ""}>\n${f.text.trim()}\n</file>`),
  ].join("\n\n");
}

export function renderTools(home = homedir()): string | undefined {
  const parts = [TOOLS_PROMPT, join(home, ".dpi", "instructions.md")]
    .filter(isFile)
    .map((p) => readFileSync(p, "utf8").trim())
    .filter(Boolean);
  return parts.length ? parts.join("\n\n") : undefined;
}

/** `defaultCwd` is the session folder, for agents without a folder of their own. */
export function createProjectContext(defaultCwd: string) {
  return defineExtension({
    name: "project-context",
    sections: [
      section("project_instructions", (input) => renderProject(input.agent.cwd ?? defaultCwd)),
      section("developer_tools", () => renderTools()),
    ],
  });
}
