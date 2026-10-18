# Durable Pi as a macOS app (Tauri): native window, menu bar, notifications. See apps/dpi-desktop.

set shell := ["zsh", "-cu"]
set working-directory := "../../apps/dpi-desktop"

app := "src-tauri/target/release/bundle/macos/Durable Pi.app"

# List desktop app commands
[default]
default:
    @just --list desktop

# Build the app (needs Rust; first build takes a few minutes)
build:
    [ -d node_modules ] || npm install --no-audit --no-fund
    npm run build

dest := env("HOME") / "Applications"

# Build, then install into ~/Applications (replaces an older copy; quits a running one first and waits for its shutdown)
install: build
    osascript -e 'quit app "Durable Pi"' 2>/dev/null || true
    for i in {1..60}; do pgrep -f "Durable Pi.app/Contents/MacOS" >/dev/null || break; sleep 1; done; true
    mkdir -p "{{ dest }}"
    rm -rf "{{ dest }}/Durable Pi.app"
    cp -R "{{ app }}" "{{ dest }}/"
    @echo "Installed: {{ dest }}/Durable Pi.app"
    @[ ! -e "/Applications/Durable Pi.app" ] || echo "Note: an older copy is in /Applications. macOS protects it; drag it to the Trash in Finder."

# Open the installed app (or the freshly built one)
open:
    open "{{ dest }}/Durable Pi.app" 2>/dev/null || open "{{ app }}"

# Run in development mode with a debug build
dev:
    npm run dev
