# Jira Flow: poll Jira for labelled tickets and work them with durable agents.
# Runs in apps/proactive-dpi-demo (shares its deps). Judge defaults to Kev (System One on :8009);
# start it first with `just judge kev`, or override DPI_JUDGE to fall back to the heuristic.

set shell := ["zsh", "-cu"]
set working-directory := "../../apps/proactive-dpi-demo"

port := "4791"

# Use a local Kev by default; set DPI_JUDGE= to disable and use the heuristic classifier.
export DPI_JUDGE := env("DPI_JUDGE", "systemone")

# List jira-flow commands
[default]
default:
    @just --list jiraflow

# Build the UI and type-check the backend
build:
    npm run jf:build

# Start the flow (serves the built UI). Needs jira-flow.config.json with your project map.
start *ARGS:
    npm run jf -- --port {{ port }} {{ ARGS }}

# Start with Vue hot reload
dev *ARGS:
    npm run jf -- --port {{ port }} --dev {{ ARGS }}

# Read-only smoke test of the jira/glab CLI adapters
smoke:
    npx tsx apps/jira-flow-be/src/smoke.ts

# Open the UI in the browser
open:
    open http://localhost:{{ port }}
