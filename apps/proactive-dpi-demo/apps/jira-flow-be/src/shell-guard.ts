// Guards for the bash tool of the ticket agent and the reviewer. They look at the commands a shell line runs —
// program and, for git and glab, the subcommand — never at the raw text. A regex over the whole line also matches
// paths and arguments: `\bjira\b` blocked every command that touched `.data/worktrees/…` under `jira-flow-be`.
//
// A seatbelt against mistakes, not a sandbox: an agent determined to hide a command (eval, a script file) gets past it.
import { basename } from "node:path";

type Command = { bin: string; args: string[] };

/** Split a shell line into words, honouring quotes; `;`, `&`, `|`, newlines, `(`, `)` and backticks end a command. */
function segments(line: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (c === "&" && (line[i - 1] === ">" || line[i + 1] === ">")) {
      word += c; // `2>&1`, `&>file`: a redirect, not a separator
      inWord = true;
    } else if (/\s/.test(c) && c !== "\n") endWord();
    else if (";&|\n()`".includes(c)) endSegment();
    else if (c === "$" && line[i + 1] === "(") endSegment();
    else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return out;
}

const WRAPPERS = new Set(["sudo", "env", "command", "exec", "nohup", "time", "nice", "xargs"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

/** Every command a shell line runs, with `bash -c "…"` unfolded. */
export function commandsOf(line: string): Command[] {
  const commands: Command[] = [];
  for (const words of segments(line)) {
    let i = 0;
    // Skip `FOO=bar` assignments and wrappers like `sudo` or `env`.
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS.has(basename(words[i])))) i++;
    if (i >= words.length) continue;
    const bin = basename(words[i]);
    const args = words.slice(i + 1);
    const inner = SHELLS.has(bin) ? args.findIndex((a) => /^-[a-z]*c$/.test(a)) : -1;
    if (inner >= 0 && args[inner + 1] !== undefined) commands.push(...commandsOf(args[inner + 1]));
    else commands.push({ bin, args });
  }
  return commands;
}

/** git's subcommand and its arguments, past global options like `-C <path>` or `-c key=value`. */
function gitSub(args: string[]): { sub: string; rest: string[] } {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"].includes(args[i])) i++;
    i++;
  }
  return { sub: args[i] ?? "", rest: args.slice(i + 1) };
}

/** Writes to a file through `>` / `>>` (anything but /dev/null and `>&2`-style duplications). */
function redirectsToFile(args: string[]): boolean {
  return args.some((a, i) => {
    const m = a.match(/^\d*>>?(.*)$/) ?? a.match(/^&>>?(.*)$/);
    if (!m) return false;
    const target = m[1] || args[i + 1] || "";
    return !target.startsWith("&") && target !== "/dev/null";
  });
}

/** The ticket agent: everything goes, except what the flow's tools own (branches, push, MR). */
export function ticketAgentBlock(line: string): string | null {
  for (const { bin, args } of commandsOf(line)) {
    if (bin === "git") {
      const { sub, rest } = gitSub(args);
      if (["push", "pull", "merge", "rebase", "switch", "worktree"].includes(sub)) return `git ${sub}`;
      if (sub === "reset" && rest.includes("--hard")) return "git reset --hard";
      if (sub === "branch" && rest.some((a) => /^(-[dDmMcCf]|--delete|--move|--copy|--force)$/.test(a)))
        return "git branch (delete/move)";
      if (sub === "checkout" && rest.some((a) => ["-b", "-B", "--orphan", "main", "master", "develop"].includes(a)))
        return "git checkout of another branch";
    }
    if (bin === "glab" && args[0] === "mr" && ["create", "merge", "approve"].includes(args[1] ?? "")) return `glab mr ${args[1]}`;
  }
  return null;
}

const GIT_WRITES = new Set([
  "add", "am", "apply", "checkout", "cherry-pick", "clean", "commit", "fetch", "gc", "merge", "mv", "notes", "prune",
  "pull", "push", "rebase", "reset", "restore", "revert", "rm", "stash", "submodule", "switch", "tag", "update-ref",
  "worktree",
]);
const BRANCH_LISTING = /^(-a|-r|-v|-vv|--all|--remotes|--list|--verbose|--show-current|--contains|--merged|--no-merged|--format=.*)$/;

/** The reviewer: reading, building and testing go; changing the tree, the refs, files or trackers does not. */
export function reviewerBlock(line: string): string | null {
  for (const { bin, args } of commandsOf(line)) {
    if (["glab", "gh", "jira"].includes(bin)) return `${bin} (tracker or network)`;
    if (["rm", "rmdir", "mv", "truncate", "chmod", "chown"].includes(bin)) return bin;
    if ((bin === "sed" || bin === "perl") && args.some((a) => /^(-i|--in-place)/.test(a))) return `${bin} -i`;
    if (args.some((a) => a === "--fix" || a.startsWith("--fix=") || a === "--write")) return "--fix / --write";
    if (redirectsToFile(args)) return "writing a file through a redirect";
    if (bin === "git") {
      const { sub, rest } = gitSub(args);
      if (GIT_WRITES.has(sub)) return `git ${sub}`;
      if (sub === "branch" && rest.some((a) => a.startsWith("-") ? !BRANCH_LISTING.test(a) : true)) return "git branch";
      if (sub === "remote" && ["add", "remove", "rm", "rename", "set-url", "set-head", "prune", "update"].includes(rest[0] ?? ""))
        return `git remote ${rest[0]}`;
    }
  }
  return null;
}
