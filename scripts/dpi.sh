#!/usr/bin/env bash
# Start, stop and check this machine's Durable Pi stack (this fork):
#
#   local judge   Kev (DPI_JUDGE=systemone on a local URL) or Ollama (DPI_JUDGE=ollama), when configured
#   dpi-backend   the device server (DPI_PORT, default 4780)
#   web hub       the web UI (DPI_HUB_PORT, default 4781)
#
#   scripts/dpi.sh start [--detach] [--restart] [--no-judge]    (start is the default)
#   scripts/dpi.sh stop [--keep-judge]
#   scripts/dpi.sh status
#   scripts/dpi.sh demo [--detach] [--keep] [demo options]   the proactive incident demo (Kev + incident agent)
#
# Works through a symlink, e.g. `just link duracel` → ~/.local/bin/duracel, then `duracel`, `duracel stop`, ….
#
# Settings come from ~/.dpi/backend.env (written by `just net up local`); environment variables override them.
# `start` runs in the foreground and follows the logs; Ctrl+C stops what this run started. Services that already
# run are reused, never started twice. Logs: ~/.dpi/logs/*.log.
set -uo pipefail

# Resolve symlinks (a link in ~/.local/bin points here), then the checkout is one level up.
SELF=$0
while [ -L "$SELF" ]; do
  target=$(readlink "$SELF")
  case $target in /*) SELF=$target ;; *) SELF=$(dirname "$SELF")/$target ;; esac
done
ROOT=$(cd "$(dirname "$SELF")/.." && pwd)
NAME=$(basename "$0")
[ "$NAME" = "dpi.sh" ] && NAME="just"
DPI_HOME=${DPI_HOME:-$HOME/.dpi}
ENV_FILE=${DPI_ENV_FILE:-$DPI_HOME/backend.env}
LOGS=$DPI_HOME/logs
RUN=$DPI_HOME/run
mkdir -p "$LOGS" "$RUN"

envval() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
BACKEND_PORT=${DPI_PORT:-$(envval DPI_PORT)}
BACKEND_PORT=${BACKEND_PORT:-4780}
HUB_PORT=${DPI_HUB_PORT:-4781}
DEMO_PORT=${DPI_DEMO_PORT:-4790}
DEMO_DIR=$ROOT/apps/proactive-dpi-demo
JUDGE=${DPI_JUDGE:-$(envval DPI_JUDGE)}
JUDGE_URL=${DPI_JUDGE_URL:-$(envval DPI_JUDGE_URL)}
JUDGE_URL=${JUDGE_URL:-http://127.0.0.1:8009}
KEV_DIR=${KEV_DIR:-$(cd "$ROOT/.." && pwd)/kev}
KEV_MODEL=${KEV_MODEL:-jaredpalmer/kev-4b@v1.0}
OLLAMA_URL=${OLLAMA_HOST:-$(envval OLLAMA_HOST)}
OLLAMA_URL=${OLLAMA_URL:-http://127.0.0.1:11434}
OLLAMA_MODEL=${DPI_JUDGE_MODEL:-$(envval DPI_JUDGE_MODEL)}
OLLAMA_MODEL=${OLLAMA_MODEL:-qwen3:4b-instruct}

# The Kev port, when the System One judge is a local server we can manage.
KEV_PORT=""
if [ "$JUDGE" = "systemone" ]; then
  case "$JUDGE_URL" in
    http://127.0.0.1:* | http://localhost:*) KEV_PORT=$(echo "$JUDGE_URL" | sed -E 's#^http://[^:]+:([0-9]+).*#\1#') ;;
  esac
fi

bold=$'\033[1m'; green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'; dim=$'\033[2m'; reset=$'\033[0m'
say() { printf '%s\n' "$*"; }
ok() { say "  ${green}✓${reset} $*"; }
warn() { say "  ${yellow}!${reset} $*"; }
fail() { say "  ${red}✗${reset} $*"; }

up() { curl -sf --max-time 2 "$1" >/dev/null 2>&1; }
listening() { lsof -ti "tcp:$1" -sTCP:LISTEN >/dev/null 2>&1; }

# wait_for NAME URL SECONDS LOG: poll until URL answers; show the log tail on failure.
wait_for() {
  local name=$1 url=$2 limit=$3 log=$4 waited=0
  while ! up "$url"; do
    if [ "$waited" -ge "$limit" ]; then
      fail "$name did not come up within ${limit}s. Last log lines ($log):"
      tail -n 15 "$log" | sed 's/^/      /'
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
    if [ $((waited % 30)) -eq 0 ]; then say "    ${dim}… still waiting for $name (${waited}s)${reset}"; fi
  done
  return 0
}

# start_bg NAME DIR CMD...: start a command in the background, log to ~/.dpi/logs/NAME.log, remember its pid.
start_bg() {
  local name=$1 dir=$2
  shift 2
  printf '\n=== %s started %s ===\n' "$name" "$(date '+%F %T')" >>"$LOGS/$name.log"
  # exec: no shell stays behind holding our stdout, and the pid file names the service itself.
  (cd "$dir" && exec nohup "$@" </dev/null >>"$LOGS/$name.log" 2>&1) &
  echo $! >"$RUN/$name.pid"
  STARTED="$STARTED $name"
}

# stop_name NAME PORT: stop the remembered process and whatever still listens on its port.
stop_name() {
  local name=$1 port=$2 pidfile="$RUN/$1.pid"
  if [ -f "$pidfile" ]; then
    kill "$(cat "$pidfile")" 2>/dev/null
    rm -f "$pidfile"
  fi
  if [ -n "$port" ]; then "$ROOT/just/free-port.sh" "$port" 2>/dev/null; fi
}

port_of() {
  case $1 in
    backend) echo "$BACKEND_PORT" ;;
    hub) echo "$HUB_PORT" ;;
    kev) echo "$KEV_PORT" ;;
    demo) echo "$DEMO_PORT" ;;
    ollama) echo "$OLLAMA_URL" | sed -E 's#^https?://[^:]+:([0-9]+).*#\1#' ;;
  esac
}

# ---------------------------------------------------------------------------------------------------------------

start_judge() {
  case "$JUDGE" in
    systemone)
      if [ -z "$KEV_PORT" ]; then
        ok "judge: System One at $JUDGE_URL (remote, not managed here)"
      elif up "$JUDGE_URL/v1/models"; then
        ok "judge: Kev already running on :$KEV_PORT"
      elif [ ! -d "$KEV_DIR" ]; then
        warn "judge: Kev not installed at $KEV_DIR. Run: just judge kev-install  (bash commands are not judged meanwhile)"
      else
        local repo=${KEV_MODEL%@*}
        local note=""
        [ -d "${HF_HOME:-$HOME/.cache/huggingface}/hub/models--${repo//\//--}" ] || note=" ${dim}(first start: downloads the model, several GB)${reset}"
        say "  … starting Kev ($KEV_MODEL) on :$KEV_PORT$note"
        start_bg kev "$KEV_DIR" uv run --extra serve python -m kev.serve --run "$KEV_MODEL" --port "$KEV_PORT"
        if wait_for Kev "$JUDGE_URL/v1/models" 900 "$LOGS/kev.log"; then ok "judge: Kev on :$KEV_PORT"; fi
      fi
      ;;
    ollama)
      if up "$OLLAMA_URL/api/tags"; then
        ok "judge: Ollama already running"
      elif ! command -v ollama >/dev/null; then
        warn "judge: ollama is not installed (bash commands are not judged)"
        return
      else
        start_bg ollama "$ROOT" ollama serve
        if wait_for Ollama "$OLLAMA_URL/api/tags" 60 "$LOGS/ollama.log"; then ok "judge: Ollama started"; fi
      fi
      if up "$OLLAMA_URL/api/tags" && ! curl -s "$OLLAMA_URL/api/tags" | grep -q "\"$OLLAMA_MODEL\""; then
        warn "judge: model $OLLAMA_MODEL is missing. Run: just judge ollama-pull"
      fi
      ;;
    "")
      say "  ${dim}judge: none configured (damage control uses offline rules; see README: Local judge)${reset}"
      ;;
    *)
      warn "judge: unknown DPI_JUDGE=$JUDGE"
      ;;
  esac
}

start_backend() {
  if up "http://127.0.0.1:$BACKEND_PORT/healthz"; then
    ok "backend already running on :$BACKEND_PORT"
    return
  fi
  if listening "$BACKEND_PORT"; then
    fail "port $BACKEND_PORT is taken by something else ($NAME start --restart frees it)"
    return 1
  fi
  start_bg backend "$ROOT/apps/dpi-backend" npm start
  if wait_for backend "http://127.0.0.1:$BACKEND_PORT/healthz" 90 "$LOGS/backend.log"; then
    ok "backend on :$BACKEND_PORT ($(grep -o 'provider: [a-z-]*' "$LOGS/backend.log" | tail -1))"
  else
    return 1
  fi
}

start_hub() {
  if up "http://127.0.0.1:$HUB_PORT/"; then
    ok "web hub already running on :$HUB_PORT"
    return
  fi
  if listening "$HUB_PORT"; then
    fail "port $HUB_PORT is taken by something else ($NAME start --restart frees it)"
    return 1
  fi
  if [ ! -f "$ROOT/apps/dpi-playground/apps/dpi-playground-fe/dist/index.html" ]; then
    say "  … building the web UI"
    (cd "$ROOT/apps/dpi-playground" && npm run build >>"$LOGS/hub.log" 2>&1) || { fail "web UI build failed (see $LOGS/hub.log)"; return 1; }
  fi
  start_bg hub "$ROOT/apps/dpi-playground" env DPI_HUB_PORT="$HUB_PORT" npm start
  if wait_for "web hub" "http://127.0.0.1:$HUB_PORT/" 60 "$LOGS/hub.log"; then ok "web hub on :$HUB_PORT"; else return 1; fi
}

cmd_start() {
  local detach=0 restart=0 judge=1
  for arg in "$@"; do
    case $arg in
      --detach | -d) detach=1 ;;
      --restart | -r) restart=1 ;;
      --no-judge) judge=0 ;;
      *) say "unknown option: $arg"; exit 2 ;;
    esac
  done
  if [ ! -f "$ENV_FILE" ]; then
    fail "$ENV_FILE is missing. Run: just net up local   (or /install in Claude Code)"
    exit 1
  fi
  if [ "$(envval DPI_PROVIDER)" = "claude-code" ] && command -v claude >/dev/null && ! claude auth status 2>/dev/null | grep -q '"loggedIn": true'; then
    warn "Claude Code is not logged in. Run: claude auth login"
  fi

  say "${bold}Durable Pi${reset} ${dim}($ROOT)${reset}"
  if [ "$restart" = 1 ]; then
    say "  … stopping backend and hub"
    stop_name hub "$HUB_PORT"
    stop_name backend "$BACKEND_PORT"
  fi
  STARTED=""
  [ "$judge" = 1 ] && start_judge
  start_backend || { cleanup; exit 1; }
  start_hub || { cleanup; exit 1; }

  say ""
  say "  ${bold}Open: http://127.0.0.1:$HUB_PORT${reset}"
  say "  ${dim}Logs: $LOGS/{backend,hub,kev,ollama}.log${reset}"

  if [ "$detach" = 1 ]; then
    say "  ${dim}Running in the background. Stop with: $([ "$NAME" = just ] && echo "just stop" || echo "$NAME stop")${reset}"
    exit 0
  fi
  if [ -z "$STARTED" ]; then
    say "  ${dim}Everything was already running; nothing to follow. Stop with: $([ "$NAME" = just ] && echo "just stop" || echo "$NAME stop")${reset}"
    exit 0
  fi
  say "  ${dim}Following the logs. Ctrl+C stops what this run started:${STARTED}${reset}"
  say ""
  trap 'cleanup; exit 0' INT TERM
  local files=""
  for name in $STARTED; do files="$files $LOGS/$name.log"; done
  # shellcheck disable=SC2086
  tail -n 0 -F $files &
  TAIL=$!
  wait "$TAIL"
}

# The proactive demo: a mock shop's log stream, judged row by row by Kev; failures open an incident and a durable
# agent fixes it, then waits for your deploy approval. Fresh take by default (--keep continues the last one).
cmd_demo() {
  local detach=0 keep=0 args=()
  for arg in "$@"; do
    case $arg in
      --detach | -d) detach=1 ;;
      --keep) keep=1 ;;
      *) args+=("$arg") ;;
    esac
  done
  say "${bold}Proactive demo${reset} ${dim}(incident agent + Kev)${reset}"
  if up "http://127.0.0.1:$DEMO_PORT/api/config"; then
    ok "already running: http://localhost:$DEMO_PORT   (fresh take: $NAME demo-stop, then $NAME demo)"
    return
  fi
  STARTED=""
  start_judge
  if [ "$JUDGE" = "systemone" ] && [ -n "$KEV_PORT" ] && ! up "$JUDGE_URL/v1/models"; then
    fail "the demo needs Kev; it is not running"
    exit 1
  fi
  if [ ! -d "$DEMO_DIR/node_modules" ]; then
    say "  … installing the demo (once)"
    (cd "$DEMO_DIR" && npm install --no-audit --no-fund >>"$LOGS/demo.log" 2>&1) || { fail "npm install failed (see $LOGS/demo.log)"; exit 1; }
  fi
  if [ ! -f "$DEMO_DIR/apps/proactive-dpi-fe/dist/index.html" ]; then
    say "  … building the demo UI (once)"
    (cd "$DEMO_DIR" && npm run build >>"$LOGS/demo.log" 2>&1) || { fail "build failed (see $LOGS/demo.log)"; exit 1; }
  fi
  if [ "$keep" = 0 ]; then
    (cd "$DEMO_DIR" && npm run reset --silent >>"$LOGS/demo.log" 2>&1) || { fail "reset failed (see $LOGS/demo.log)"; exit 1; }
    ok "fresh take: the bug goes live 5 s after the start"
  fi
  if [ "$detach" = 1 ]; then
    start_bg demo "$DEMO_DIR" npm start --silent -- ${args[@]+"${args[@]}"}
    if wait_for demo "http://127.0.0.1:$DEMO_PORT/api/config" 90 "$LOGS/demo.log"; then
      ok "demo on http://localhost:$DEMO_PORT"
      say "  ${dim}Open it now: the incident opens about 11 s after the start. Stop with: $NAME demo-stop${reset}"
    else
      exit 1
    fi
    return
  fi
  say "  ${bold}Open: http://localhost:$DEMO_PORT${reset}  ${dim}(Ctrl+C stops the demo; Kev keeps running)${reset}"
  cd "$DEMO_DIR" && exec npm start --silent -- ${args[@]+"${args[@]}"}
}

cmd_demo_stop() {
  if [ -f "$RUN/demo.pid" ] || listening "$DEMO_PORT"; then
    stop_name demo "$DEMO_PORT"
    pkill -INT -f "$DEMO_DIR/node_modules/.bin/tsx scripts/demo.ts" 2>/dev/null
    ok "demo stopped"
  else
    say "  ${dim}demo not running${reset}"
  fi
}

cleanup() {
  [ -n "${TAIL:-}" ] && kill "$TAIL" 2>/dev/null
  [ -z "${STARTED:-}" ] && return
  say ""
  say "  … stopping:${STARTED}"
  # Reverse order: hub, backend, then the judge.
  for name in hub backend kev ollama; do
    case " $STARTED " in *" $name "*) stop_name "$name" "$(port_of "$name")" ;; esac
  done
  ok "stopped"
  STARTED=""
}

cmd_stop() {
  local keep_judge=0
  [ "${1:-}" = "--keep-judge" ] && keep_judge=1
  say "${bold}Stopping Durable Pi${reset}"
  if listening "$DEMO_PORT"; then cmd_demo_stop; fi
  stop_name hub "$HUB_PORT" && ok "web hub"
  stop_name backend "$BACKEND_PORT" && ok "backend"
  if [ "$keep_judge" = 0 ]; then
    # Only judges this script started (a pid file), or a Kev on the configured port.
    if [ -n "$KEV_PORT" ] && listening "$KEV_PORT" && ps -o command= -p "$(lsof -ti "tcp:$KEV_PORT" -sTCP:LISTEN | head -1)" | grep -q "kev.serve"; then
      stop_name kev "$KEV_PORT" && ok "Kev"
    fi
    if [ -f "$RUN/ollama.pid" ]; then stop_name ollama "" && ok "Ollama (started by this script)"; fi
  fi
}

cmd_status() {
  say "${bold}Durable Pi status${reset}"
  if up "http://127.0.0.1:$BACKEND_PORT/healthz"; then ok "backend      http://127.0.0.1:$BACKEND_PORT"; else fail "backend      not running"; fi
  if up "http://127.0.0.1:$HUB_PORT/"; then ok "web hub      http://127.0.0.1:$HUB_PORT"; else fail "web hub      not running"; fi
  case "$JUDGE" in
    systemone) if up "$JUDGE_URL/v1/models"; then ok "judge (Kev)  $JUDGE_URL"; else fail "judge (Kev)  not reachable at $JUDGE_URL"; fi ;;
    ollama) if up "$OLLAMA_URL/api/tags"; then ok "judge        Ollama $OLLAMA_MODEL"; else fail "judge        Ollama not running"; fi ;;
    *) say "  ${dim}judge        none configured${reset}" ;;
  esac
  if up "http://127.0.0.1:$DEMO_PORT/api/config"; then ok "demo         http://localhost:$DEMO_PORT"; else say "  ${dim}demo         not running ($NAME demo)${reset}"; fi
}

usage() {
  say "${bold}$NAME${reset}: Durable Pi on your Claude subscription ($ROOT)"
  say ""
  say "  $NAME [start]            judge (Kev/Ollama), backend and web UI; follows the logs, Ctrl+C stops them"
  say "  $NAME start --detach     the same in the background"
  say "  $NAME start --restart    restart backend and web UI (keeps a running Kev)"
  say "  $NAME start --no-judge   without the local judge"
  say "  $NAME status             what runs"
  say "  $NAME stop               stop backend, web UI, Kev and the demo (--keep-judge leaves Kev running)"
  say ""
  say "  $NAME demo               the proactive incident demo with Kev: fresh take, opens on :$DEMO_PORT (Ctrl+C stops it)"
  say "  $NAME demo -d            the same in the background ($NAME demo-stop stops it)"
  say "  $NAME demo --keep        continue the last take instead of starting fresh"
  say "                           demo options pass through, e.g. --tts off, --model claude-opus-5-5"
  say ""
  say "  Web UI: http://127.0.0.1:$HUB_PORT   Logs: $LOGS"
}

case "${1:-start}" in
  start) shift || true; cmd_start "$@" ;;
  -*) case $1 in -h | --help) usage ;; *) cmd_start "$@" ;; esac ;;
  stop) shift; cmd_stop "$@" ;;
  status) cmd_status ;;
  demo) shift; cmd_demo "$@" ;;
  demo-stop) cmd_demo_stop ;;
  help) usage ;;
  *) usage; exit 2 ;;
esac
