# Durable Pi desktop app (macOS, Tauri)

The web UI in a native window, plus what a browser tab cannot do:

- **Starts the stack** (Kev, backend, web hub) through `scripts/dpi.sh` when it opens; **Quit** (menu bar or ⌘Q)
  stops it all.
- **Closing the window only hides it**: agents keep working. The menu bar icon and the Dock bring it back.
- **Menu bar**: status (running, Kev), open pending approvals, start, open and stop the proactive incident demo
  (own window), restart backend and web UI, quit.
- **Notifications** when a tool call waits for approval (`🔐 Freigabe nötig: bash`, with the command) or an agent
  finishes while the window is in the background. A click opens that agent (`#open=<device>/<session>/<agent>`).
- **Dock badge** with the number of pending approvals.

```bash
just desktop install   # build (Rust, a few minutes the first time) and copy to /Applications
just desktop open      # start it
just desktop dev       # debug build with dev tools
```

The app is a thin shell (~7 MB): Node, `just`, `uv` and the checkout stay where they are. It finds the checkout it
was built from (override with `DURACEL_ROOT`) and asks your login shell for `PATH`, so nvm, uv and claude are found
when it starts from Finder. Builds are ad-hoc signed (`signingIdentity: "-"`), which macOS needs for notifications;
allow them when macOS asks. Sharing the app with others would need a Developer ID signature.
