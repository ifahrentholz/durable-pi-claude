# Durable Pi. Recipes are grouped by work area under just/<group>/mod.just.
# Device recipes take an id from dpi-network.yaml; nothing here names a machine.
set dotenv-load := true
set shell := ["zsh", "-cu"]

# Devices: up, deploy, status, logs, restart
mod net 'just/net'

# This machine's dpi-backend
mod backend 'just/backend'

# Web UI hub on port 4781
mod hub 'just/hub'

# Terminal client for one device
mod tui 'just/tui'

# Unit, UI, device and e2e suites
mod test 'just/test'

# Proactive DPI demo: just proactive <command>
mod proactive 'just/proactive'

# Jira Flow: poll Jira, work tickets with durable agents: just jiraflow <command>
mod jiraflow 'just/jiraflow'

# Local decision model for damage control: Kev or Ollama (this fork)
mod judge 'just/judge'

# Durable Pi as a macOS app: build, install, open (this fork)
mod desktop 'just/desktop'

# List command groups
default:
    @just --list

# Start judge (Kev/Ollama), backend and web hub; follows logs, Ctrl+C stops (--detach, --restart, --no-judge)
start *ARGS:
    @scripts/dpi.sh start {{ ARGS }}

# Stop backend, web hub and the local judge (--keep-judge leaves Kev running)
stop *ARGS:
    @scripts/dpi.sh stop {{ ARGS }}

# Show what runs: backend, web hub, judge
status:
    @scripts/dpi.sh status

# Put a command for scripts/dpi.sh on your PATH: just link [name] [dir] (default: dpi in ~/.local/bin)
link NAME="dpi" DIR=(env("HOME") / ".local/bin"):
    @mkdir -p "{{ DIR }}" && ln -sfn "{{ justfile_directory() }}/scripts/dpi.sh" "{{ DIR }}/{{ NAME }}" && echo "{{ DIR }}/{{ NAME }} → scripts/dpi.sh. Try: {{ NAME }} --help"

# Install dependencies for every network app
install:
    cd apps/dpi-sdk && npm install --no-audit --no-fund
    cd apps/dpi-backend && npm install --no-audit --no-fund
    cd apps/dpi-playground && npm install --no-audit --no-fund
    cd apps/dpi-tui && npm install --no-audit --no-fund

# Type checks and unit tests, every app
check: test::unit
