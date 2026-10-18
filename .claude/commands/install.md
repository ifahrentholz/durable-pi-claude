---
description: Install Durable Pi (Claude subscription fork): prerequisites, Claude Code login, app dependencies, the web UI build, this machine's device config, an optional local judge and the optional proactive demo
---

# Install Durable Pi on a Claude subscription

## Purpose

Set up this checkout so this machine can run a `dpi-backend` device whose agents answer through Claude Code on the
user's Claude subscription (the `claude-code` provider), plus the web hub and the terminal client. Check prerequisites,
confirm the Claude Code login, install the network apps, build the web UI, write this machine's device config,
optionally set up a local decision model for damage control (Kev or Ollama), and verify with the test suite. This is
an interactive, agentic process: ask the user when a choice is needed.

## Variables

SOURCE_REPO: the directory this command runs from (the repo root, where `justfile` lives)
NETWORK_FILE: `dpi-network.yaml` (gitignored device declarations; template `dpi-network.example.yaml`; every `just net` recipe takes an id from it)
ENV_FILE: `.env` at the repo root (template: `.env.example`; only needed for the openrouter provider and the proactive demo)
DEVICE_HOME: `~/.dpi` (`backend.env` with the device token, `backend/` data, `network.sqlite` hub registry, optional `instructions.md`)
APPS: `apps/dpi-sdk`, `apps/dpi-backend`, `apps/dpi-playground`, `apps/dpi-tui`

## Codebase Structure

```text
justfile                 # groups: net, backend, hub, tui, test, proactive, judge (just/<group>/mod.just)
dpi-network.example.yaml # template: defaults (DPI_PROVIDER: claude-code) + the local device, commented ssh and exe-dev examples
apps/dpi-backend/src/claude-code.ts      # the claude-code provider (Claude Agent SDK bridge)
apps/dpi-backend/src/approvals.ts        # tool approvals
apps/dpi-backend/src/project-context.ts  # CLAUDE.md / AGENTS.md and developer-tool instructions
apps/dpi-backend/src/jev.ts              # pluggable judge: Jev, local Kev/Laya (System One), Ollama
apps/dpi-backend/prompts/developer-tools.md
scripts/dpi.sh           # start | stop | status for judge, backend and web UI; `just start`, `just link <name>` for a PATH command
```

## Instructions

- Run every check via Bash. Do not assume anything is installed.
- Show a status line right after each check (pass or fail).
- Install auto-installable items without asking. Ask the user before anything that needs their input or downloads a model.
- Never read, print or echo an API key, token or credential. Only confirm that it is set.
- Never run `claude auth login` yourself: it opens a browser. Ask the user to run it.
- Never start servers or long-running processes (`just backend run`, `just hub start`, `just tui attach`, `just judge kev`). Only verify readiness.
- Do not run `just net up` for any device except `local`.
- Do not run the device suites (`just test device`, `just test e2e`): they call a real model.

## Workflow

### Step 1 — Check Prerequisites

Critical, so stop and guide the user if any is missing:

1. `command -v node && node -v`: Node.js **24 or newer** (the backend uses `node:sqlite`). `nvm install 24 && nvm use 24`.
2. `command -v npm && npm -v`.
3. `command -v just && just --version`: `brew install just`.
4. `command -v zsh`: every `just` recipe runs in zsh.
5. `command -v git`.
6. `command -v claude && claude --version`: Claude Code. Install from https://code.claude.com if missing.

Optional, so report them and continue:

7. `command -v jira`, `command -v glab`, `command -v gh`: the developer-tool instructions tell agents to read Jira tickets, GitLab merge requests and GitHub pull requests with them. For each that exists, check it is logged in without printing secrets: `jira me`, `glab auth status`, `gh auth status`.
8. `command -v uv` (for a local Kev judge) and `command -v ollama` (for an Ollama judge).
9. `command -v ssh && command -v rsync`, `command -v tmux`, Google Chrome (Playwright UI suites), `curl`, `sqlite3`, `openssl`, as upstream.

### Step 2 — Check the Claude login

1. `claude auth status`: must report `"loggedIn": true` with a claude.ai login (`authMethod` `claude.ai`). If not, ask the user to run `claude auth login` in their own terminal, then re-check.
2. `[ -z "$ANTHROPIC_API_KEY" ] && echo unset || echo "set (it is never passed to Claude Code, requests use the subscription login)"`.
3. Tell the user in one sentence: agents run through Claude Code on their Claude plan, so the plan's usage limits apply; dollar amounts in the UI are API equivalents for comparison.

### Step 3 — Install Dependencies

1. `just install`: `npm install` in the four network apps.
2. Ask whether to set up the proactive demo. It needs an OpenRouter key in `.env` (Sonnet through OpenRouter and Jev); skip it otherwise.

### Step 4 — Verify Configuration

1. If `dpi-network.yaml` is missing, create it: `cp dpi-network.example.yaml dpi-network.yaml`. Never overwrite an existing one. Confirm its defaults set `DPI_PROVIDER: claude-code`.
2. Ask which folders new sessions should start in and set `start_dirs` accordingly (default `~/dpi-work`).
3. `just net ids`: lists device ids, including `local`.
4. `just net up local`: writes `~/.dpi/backend.env` (mode 600) and registers the device. Never print the file.
5. `just hub build`.

### Step 5 — Optional: local judge for damage control

The Extend tab's **Damage control** extension asks a decision model about every bash command and blocks destructive
ones. Without a judge it uses built-in offline rules. Ask the user which they want:

- **Kev (recommended)**: a small Jev-like decision model with calibrated probabilities, about 300 ms per command on
  Apple Silicon. Needs `uv`; the first start downloads the model (several GB). Run `just judge kev-install`, then tell
  the user to start it with `just judge kev` (port 8009) and set `DPI_JUDGE: systemone` under the device's `env` in
  `dpi-network.yaml`, followed by `just net up local`.
- **Ollama**: if Ollama runs already. `just judge ollama-pull` (default `qwen3:4b-instruct`; thinking-only models do not
  work), then `DPI_JUDGE: ollama` in `dpi-network.yaml` and `just net up local`.
- **None**: offline rules.

If a judge is configured and running, `just judge probe` shows its verdicts for a few commands.

### Step 6 — Optional: a command on the PATH

Ask whether the user wants one command for the whole stack (judge, backend, web UI) that works from any folder, and
which name (default `dpi`; any free name works, e.g. `duracel`). Then:

1. Pick the folder: `~/.local/bin` if it is on the PATH (`echo "$PATH" | tr ':' '\n' | grep -qx "$HOME/.local/bin"`),
   otherwise ask the user for a folder that is, or tell them to add `export PATH="$HOME/.local/bin:$PATH"` to their
   shell profile.
2. Check the name is free: `command -v <name>` must print nothing, or point at an existing link to this checkout's
   `scripts/dpi.sh` (`readlink "$(command -v <name>)"`). Never replace another program; ask for another name instead.
3. `just link <name>` (or `just link <name> <folder>`): a symlink to `scripts/dpi.sh`. The script resolves the link to
   find this checkout, so it works from any folder; rerun the recipe if the checkout moves.
4. Verify from another folder: `(cd /tmp && <name> --help)` names the command and shows this checkout's path.
5. Tell the user that an already open shell may need `hash -r` (or a new terminal) to find it.

### Step 7 — Verify Readiness

1. `just --list`: shows the groups net, backend, hub, tui, test, proactive and judge.
2. `just check`: type checks and unit tests for every app (faux model and a fake Claude Code; no network, no cost).
3. Optional, if Chrome is installed: `just test ui`.

### Step 8 — Report

Print a table with one row per check (prerequisites, Claude login, `just install`, `just net ids`, `just net up local`,
`just hub build`, `just check`, the optional CLIs, the judge and the PATH command). Mark each `pass`, `fail` or `skipped`, then give a
ready count.

Next steps, each in its own terminal:

```bash
just start                    # judge (Kev/Ollama), backend and web UI: http://127.0.0.1:4781 (Ctrl+C stops)
just start --detach           # the same in the background; `just stop` / `just status`
<name>                        # the same from any folder, if a PATH command was set up (<name> -d, status, stop)
just tui attach local         # terminal client on the same device
```

In the web UI, create a session in a project folder and pick a model marked **Abo**. Agents ask before bash and other
changes (Approvals), read the folder's CLAUDE.md / AGENTS.md (Project context), and fetch Jira tickets with the
`jira` CLI. Personal instructions for every agent on this machine go in `~/.dpi/instructions.md`.
