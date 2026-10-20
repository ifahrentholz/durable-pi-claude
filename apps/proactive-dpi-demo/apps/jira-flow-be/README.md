# jira-flow-be

Durable agent flotte that works Jira tickets end-to-end: poll → classify (Kev) →
start → implement → review → open MR → approval (GitLab or Jira) → merge. Mirrors
the structure of `proactive-dpi-be`, but the trigger is a labelled Jira ticket
instead of a log cluster, and the deploy becomes a GitLab merge.

Architecture doc: `../../../../docs/jira-flow-architecture.md`.
UI mockup: `../../../../docs/jira-flow-ui-mockup.html`.

## Run it

1. **Project map.** Copy `../../jira-flow.config.example.json` to
   `../../jira-flow.config.json` and fill in your Jira project key → GitLab repo
   mapping.
2. **Kev (the judge).** In one terminal: `just judge kev` (serves Kev on :8009).
   First run: `just judge kev-install`.
3. **Build + start.** `just jiraflow build` once, then `just jiraflow start`
   (defaults `DPI_JUDGE=systemone`, so it uses Kev). Dev mode with hot reload:
   `just jiraflow dev`. Open `http://localhost:4791`.

Without Kev running the classifier falls back to a heuristic, so the flow still
works — the queue labels just come from the heuristic instead of Kev.

CLI flags override single config fields (`--poll 15`, `--max 2`, `--model …`,
`--label …`, `--approval gitlab-only`). Poll interval ∈ {5,10,15,20,30,60}.

### Lanes (after omnigent-radar)

Kev classifies each ticket into a lane; the start popup shows it and lets you override it. The lane decides what
the agent does (`src/lanes.ts`), and the tools refuse steps outside it:

| Lane | Chain |
|---|---|
| question | answer in the session, no code, no MR |
| quick | implement → review → MR (`reviewQuick: false` drops the review) |
| ticket | implement → review → MR |
| feature | **grill** → implement → review → MR |

- **Grill:** a feature, or any code ticket Kev marks `needs_clarification`, starts with an interview in the agent
  chat: one question at a time with a recommended answer, until you confirm scope and acceptance criteria
  (`confirm_scope`). The Jira ticket stays the spec; the confirmed scope sharpens it, shows on the ticket card,
  goes to the reviewer and into the MR description. A ticket in the grill waits for you and holds no slot.
- **Review:** `request_review` starts an independent reviewer: its own conversation on `reviewerModel`
  (default Opus, never routed by tier), read-only by hook (`shell-guard.ts`). It gets the ticket, the acceptance
  criteria and the branch — never the agent's reasoning — re-runs the gates and classifies every finding as
  blocking, risk or minor, every gate as pass, fail or not_run. **The verdict is derived in code**
  (`review-policy.ts`), not chosen by the model:
  - blocking or a failing gate → back to the agent; still there after `maxReviewRounds` tries → ticket blocked.
  - risk → back to the agent (fix it or disprove it with a test); still there after the last try → the MR is opened
    as a **draft** with an "Open risks" section on top, the ticket shows "Decision needed".
  - a gate that could not run → straight to "Open risks" (the agent cannot fix the environment).
  - minor only → a ready MR, the notes in its description.

  `open_mr` only works on a commit whose review passed. The card links to the reviewer's session.
- **Draft follows the flow:** the MR is ready only while its head passed review with no open risk and no rework
  runs. Starting a rework drafts it at once (with a note in the MR); a clean review of the rework makes it ready
  again. Commits reach the MR only through `open_mr`, so a blocked rework never lands in it.
- **Rework on an open MR:** ask the agent for a change in its chat. `submit_fix` moves the ticket back to
  implement, the new commit goes through a new review cycle (its own `maxReviewRounds` tries), and `open_mr` pushes
  it to the same MR — no new MR, no second Jira comment. (Not while auto-merge is waiting.)
- Not built (yet): splitting a feature into child tickets in Jira; the agent implements it in the same ticket.

### How approval works

**Default (`autoMerge: false`): the agent only opens the MR and stops.** A human
reviews, approves, and merges it in GitLab. The MR targets the project's
`defaultBranch` (what you branched from — e.g. `main` or `develop`). The agent
never merges and never touches the target branch itself.

**Jira gets one comment per ticket**, when the MR is opened: one sentence on what was fixed, then the MR link.
Stage changes only show in the flow UI.

**Opt-in auto-merge (`autoMerge: true` or `--auto-merge`):** after opening the
MR the agent waits durably for approval — a GitLab approve, a `/approve` comment
on the Jira ticket, **or** the “Approve & merge” button in the UI — then merges
it. `/decline` or the Decline button cancels. The wait survives a backend restart.

### Model routing

The default agent is **Opus 5.5**. Kev classifies each ticket's complexity and
the agent starts on the matching model — **Sonnet 5.5** for simple/moderate,
**Opus 5.5** for complex (floor Sonnet, ceiling Opus). The start popup lets you
override per ticket (Auto = Kev's tier).

Concurrency is capped at `maxConcurrent` (default 3); extra ready tickets wait in
the prio-sorted feed until a slot frees.

Requires the `jira` and `glab` CLIs configured on the machine (they are).

## Config

`../../jira-flow.config.json`, one entry per Jira project key under `projects`:

```json
"PROJ": {
  "gitlab": { "host": "gitlab.example.com", "repo": "group/project" },
  "defaultBranch": "develop",
  "branchTemplate": "feature/{key}",
  "testCommand": "npm test"
}
```

- `defaultBranch`: the worktree branches off it and the MR targets it (default `main`).
- `branchTemplate`: `{key}` (PROJ-123), `{key_lower}`, `{project}`, `{number}`. Default `feature/{key}`, also
  settable globally or with `--branch`. A ticket keeps the branch name it got at discovery.
- `testCommand`: run in the worktree by `submit_fix` before it commits; a failure rejects the commit. None: no tests.
- `remote`: clone URL, default `git@<host>:<repo>.git`. A ticket label `repo:<group/project>` overrides the repo.

Base clones live in `.data/repos/<repo-slug>`, worktrees in `.data/worktrees/<TICKET-KEY>` (see `paths.ts`).

## Build status (file by file)

| File | Role | Status |
|---|---|---|
| `paths.ts` | data/worktree/config paths | ✅ done |
| `types.ts` | domain types (Ticket, Merge, Stage, Classification, RepoTarget) | ✅ done |
| `config.ts` | config load + project map + poll enum + model tiers | ✅ done |
| `jira.ts` | `jira` CLI adapter (list/view/comment/transition) | ✅ done, smoke-tested |
| `gitlab.ts` | `glab` CLI adapter (createMr/approvals/merge/mergeStatus) | ✅ done, api smoke-tested |
| `mapping.ts` | Jira project → GitLab repo + worktree resolution | ✅ done |
| `judge.ts` | Kev/Jev client (standalone copy) | ✅ done |
| `classify.ts` | lane/tier/readiness classification (+ heuristic fallback) | ✅ done |
| `poller.ts` | poll JQL, prio-sort, classify new tickets, emit | ✅ done |
| `smoke.ts` | read-only CLI smoke test | ✅ passes |
| `repo.ts` | per-repo base clone + per-ticket worktree + commit + push | ✅ done |
| `lanes.ts` | lane plans, the agent's lane playbook, reviewer brief | ✅ done |
| `review-policy.ts` | review verdict from classified findings + gates, MR description with open risks (`review-policy.test.ts`) | ✅ tested |
| `shell-guard.ts` | bash guards of ticket agent and reviewer: parse commands, judge program + git subcommand (`npx tsx --test apps/jira-flow-be/src/shell-guard.test.ts`) | ✅ tested |
| `cli.ts` | runs git/glab/jira with stdin closed (jira-cli otherwise waits on stdin) | ✅ done |
| `extensions.ts` | Tickets/Merges/Reviews docs, ticket tools (update_ticket/confirm_scope/answer_question/submit_fix/request_review/open_mr), reviewer (submit_review), MergeTask approval phase | ✅ done |
| `ops.ts` | harness orchestrator: ownerless conversations, recover, start-with-cap, actions | ✅ done |
| `main.ts` | express + SSE server | ✅ done, boot-tested |
| `../jira-flow-fe/*` | UI: ticket feed (table) + agent panel + start modal, from the demo | ✅ done, builds |

The whole backend type-checks and boot-tests (server starts, `/api/config` and
`/api/stream` respond, poller tolerant of empty results). The frontend passes
`vue-tsc` and `vite build`. CLI adapters verified against the live `jira`/`glab`
CLIs (44 issues parsed, GitLab api authenticated).

Not yet built: the feature fan-out into Jira child tickets (a feature is grilled and implemented in its own
ticket).
Jira status transitions are comment-based; a per-project status map can be added
later (unknown statuses vary per Jira project).
