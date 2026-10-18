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

# Build, then install into /Applications (replaces an older copy; quits a running one first)
install: build
    osascript -e 'quit app "Durable Pi"' 2>/dev/null || true
    sleep 2
    rm -rf "/Applications/Durable Pi.app"
    cp -R "{{ app }}" /Applications/
    @echo "Installed: /Applications/Durable Pi.app"

# Open the installed app (or the freshly built one)
open:
    open "/Applications/Durable Pi.app" 2>/dev/null || open "{{ app }}"

# Run in development mode with a debug build
dev:
    npm run dev
