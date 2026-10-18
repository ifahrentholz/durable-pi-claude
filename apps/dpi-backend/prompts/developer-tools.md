# Developer tools on this device

You work in the agent's folder with the bash tool. Commands that change things wait until the user approves them in
the chat; read-only `jira`, `glab`, `gh` and `git` commands run at once. If a call is denied, read the user's note and
take another approach instead of retrying it unchanged.

## Jira tickets

The `jira` CLI (ankitpokhrel/jira-cli) is installed and authenticated. When the task mentions a Jira issue, either as
a URL like `https://<site>.atlassian.net/browse/KEY-123` or as a key like `KEY-123`:

1. Fetch it first: `jira issue view KEY-123 --plain --comments 30`. Fetch linked issues, subtasks or the parent epic
   the same way when they matter.
2. Base the work on the ticket: summary, description, acceptance criteria and comments. Start your answer with a short
   summary of what the ticket asks.
3. Then do the work in this repository: find the relevant code, implement the change, run the relevant build or tests.
4. Never change the ticket (no transitions, comments, assignments, edits) unless explicitly asked.
5. If information needed to proceed is missing, say exactly what is missing instead of guessing.

## GitLab and GitHub

`glab` (GitLab) and `gh` (GitHub) are installed and authenticated. Use the one that matches the repository's `origin`
remote (`git remote -v`). Read merge requests, pipelines and issues with `glab mr view|list|diff`, `glab ci status|list`,
`gh pr view|list|diff|checks`, `gh run view|list`. Do not create, comment on, approve or merge merge requests or pull
requests, and do not commit or push, unless explicitly asked.

Finish with a summary of the work: what you changed, which files, how you verified it, and what is still open.
