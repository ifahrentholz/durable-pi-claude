# Local decision model for jev-damage-control (this fork): Kev (System One API) or Ollama.
# Point a device at it in dpi-network.yaml: env: { DPI_JUDGE: systemone } or { DPI_JUDGE: ollama }.

set shell := ["zsh", "-cu"]
set positional-arguments

kev_dir := env("KEV_DIR", source_directory() / ".." / ".." / ".." / "kev")
kev_model := env("KEV_MODEL", "jaredpalmer/kev-4b@v1.0")
ollama_model := env("DPI_JUDGE_MODEL", "qwen3:4b-instruct")

# List judge commands
[default]
default:
    @just --list judge

# Clone Kev next to this checkout and install its server (needs uv; Python 3.12/3.13)
kev-install:
    @[ -d "{{ kev_dir }}" ] || git clone https://github.com/jaredpalmer/kev.git "{{ kev_dir }}"
    cd "{{ kev_dir }}" && uv sync --extra serve

# Serve Kev on :8009 (first run downloads the model; MLX on Apple Silicon, CUDA elsewhere)
kev:
    cd "{{ kev_dir }}" && uv run --extra serve python -m kev.serve --run "{{ kev_model }}" --port 8009

# Pull the Ollama judge model (default qwen3:4b-instruct; a thinking-only model does not work)
ollama-pull:
    ollama pull "{{ ollama_model }}"

# Ask the configured judge about a few commands (reads ~/.dpi/backend.env like the backend)
probe:
    cd ../../apps/dpi-backend && npx tsx scripts/judge-probe.ts
