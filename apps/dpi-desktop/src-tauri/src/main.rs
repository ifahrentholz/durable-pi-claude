// Durable Pi as a macOS app: the web UI in a native window, plus what a browser tab cannot do.
//
//   - Starts the stack (Kev, backend, web hub) through scripts/dpi.sh when it opens, and stops it on Quit.
//   - Closing the window only hides it: agents keep working; the menu bar icon and the Dock bring it back.
//   - Menu bar: status, open pending approvals, the proactive incident demo, restart, quit.
//   - Notifications when a tool call waits for approval or an agent finishes; a click opens that agent.
//   - The Dock badge counts pending approvals.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const HUB: &str = "http://127.0.0.1:4781";
const DEMO: &str = "http://localhost:4790";
const POLL: Duration = Duration::from_secs(3);

/// The checkout this app belongs to: DURACEL_ROOT, else the repository this binary was built from.
fn repo_root() -> PathBuf {
    if let Ok(root) = std::env::var("DURACEL_ROOT") {
        return PathBuf::from(root);
    }
    let built = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    built.canonicalize().unwrap_or(built)
}

/// Apps started from Finder get a minimal PATH. Ask the user's login shell once for theirs (nvm, uv, just, claude).
fn login_path() -> String {
    let fallback = {
        let home = std::env::var("HOME").unwrap_or_default();
        format!("{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    };
    let Ok(mut child) = Command::new("/bin/zsh")
        .args(["-lic", "print -r -- \"__PATH__=$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return fallback;
    };
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                return fallback;
            }
        }
    }
    let output = child.wait_with_output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    output
        .lines()
        .find_map(|l| l.strip_prefix("__PATH__="))
        .map(|p| format!("{p}:{fallback}"))
        .unwrap_or(fallback)
}

#[derive(Clone)]
struct Ctx {
    root: PathBuf,
    path: String,
}

impl Ctx {
    /// Run scripts/dpi.sh with the user's PATH; returns its combined output.
    fn dpi(&self, args: &[&str]) -> String {
        let out = Command::new("/bin/bash")
            .arg(self.root.join("scripts/dpi.sh"))
            .args(args)
            .current_dir(&self.root)
            .env("PATH", &self.path)
            .stdin(Stdio::null())
            .output();
        match out {
            Ok(o) => format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)),
            Err(e) => format!("scripts/dpi.sh: {e}"),
        }
    }
}

/// Settings of this device: ~/.dpi/backend.env.
fn device_env() -> HashMap<String, String> {
    let home = std::env::var("DPI_HOME").unwrap_or_else(|_| format!("{}/.dpi", std::env::var("HOME").unwrap_or_default()));
    let file = std::env::var("DPI_ENV_FILE").unwrap_or_else(|_| format!("{home}/backend.env"));
    std::fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect()
}

fn up(url: &str) -> bool {
    ureq::get(url).timeout(Duration::from_secs(2)).call().is_ok()
}

fn get_json(url: &str, token: &str) -> Option<Value> {
    ureq::get(url)
        .timeout(Duration::from_secs(5))
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .ok()?
        .into_json()
        .ok()
}

/// One agent of the device tree, as the poller sees it.
#[derive(Clone, Default)]
struct AgentSeen {
    busy: bool,
    approvals: u64,
}

#[derive(Default)]
struct State {
    agents: HashMap<String, AgentSeen>,
    notified: HashSet<String>,
    /// The agent the latest notification was about: the Dock icon and the menu open it.
    last_target: Option<String>,
    pending: u64,
    first_poll_done: bool,
}

struct Menus {
    status: MenuItem<tauri::Wry>,
    approvals: MenuItem<tauri::Wry>,
    demo_open: MenuItem<tauri::Wry>,
    demo_stop: MenuItem<tauri::Wry>,
}

fn main_window(app: &AppHandle) -> WebviewWindow {
    if let Some(w) = app.get_webview_window("main") {
        return w;
    }
    let w = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Durable Pi")
        .inner_size(1500.0, 950.0)
        .min_inner_size(900.0, 600.0)
        .build()
        .expect("main window");
    let hide = w.clone();
    w.on_window_event(move |event| {
        // Closing only hides the window: the agents keep working.
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hide.hide();
        }
    });
    w
}

fn show(app: &AppHandle) {
    let w = main_window(app);
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
}

/// Show the web UI with an agent selected (`target` is "<device>/<session>/<agent>").
fn open_agent(app: &AppHandle, target: &str) {
    show(app);
    let w = main_window(app);
    let on_hub = w.url().map(|u| u.as_str().starts_with(HUB)).unwrap_or(false);
    if on_hub {
        let _ = w.eval(&format!("location.hash = 'open={}'", target.replace('\'', "")));
    } else if let Ok(url) = format!("{HUB}/#open={target}").parse() {
        let _ = w.navigate(url);
    }
}

fn open_demo(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("demo") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    if let Ok(url) = DEMO.parse() {
        let _ = WebviewWindowBuilder::new(app, "demo", WebviewUrl::External(url))
            .title("Durable Pi – Incident-Demo (Kev)")
            .inner_size(1600.0, 1000.0)
            .build();
    }
}

#[cfg(target_os = "macos")]
fn notify(app: &AppHandle, title: &str, subtitle: &str, message: &str, target: Option<String>) {
    use mac_notification_sys::{send_notification, Notification, NotificationResponse};
    let (title, subtitle, message) = (title.to_string(), subtitle.to_string(), message.to_string());
    let app = app.clone();
    // One thread per notification: it waits for the click, then opens the agent.
    thread::spawn(move || {
        let response = send_notification(
            &title,
            Some(&subtitle),
            &message,
            Some(Notification::new().sound("Ping").wait_for_click(true)),
        );
        if let (Ok(NotificationResponse::Click), Some(target)) = (response, target) {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || open_agent(&handle, &target));
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn notify(_app: &AppHandle, _title: &str, _subtitle: &str, _message: &str, _target: Option<String>) {}

/// Every few seconds: the device tree (approvals, busy agents), the judge and the demo. Drives notifications,
/// the Dock badge and the menu bar.
fn poll(app: AppHandle, state: Arc<Mutex<State>>, menus: Arc<Menus>, tray: TrayIcon) {
    loop {
        let env = device_env();
        let token = env.get("DPI_TOKEN").cloned().unwrap_or_default();
        let port = env.get("DPI_PORT").cloned().unwrap_or_else(|| "4780".into());
        let backend = format!("http://127.0.0.1:{port}");
        let judge = env.get("DPI_JUDGE").cloned().unwrap_or_default();
        let judge_url = env.get("DPI_JUDGE_URL").cloned().unwrap_or_else(|| "http://127.0.0.1:8009".into());

        let tree = get_json(&format!("{backend}/v1/tree"), &token);
        let hub_up = up(HUB);
        let judge_up = judge == "systemone" && up(&format!("{judge_url}/v1/models"));
        let demo_up = up(&format!("{DEMO}/api/config"));

        let mut events: Vec<(String, String, String, Option<String>)> = Vec::new();
        let mut total = 0u64;
        if let Some(tree) = &tree {
            let device = tree["name"].as_str().unwrap_or("local").to_string();
            let mut st = state.lock().unwrap();
            let mut seen_now = HashMap::new();
            for session in tree["sessions"].as_array().into_iter().flatten() {
                let sid = session["id"].as_str().unwrap_or_default();
                let sname = session["name"].as_str().unwrap_or("Session");
                for agent in session["agents"].as_array().into_iter().flatten() {
                    let aid = agent["id"].as_u64().unwrap_or(0);
                    let aname = agent["name"].as_str().unwrap_or("Agent");
                    let key = format!("{device}/{sid}/{aid}");
                    let now = AgentSeen { busy: agent["busy"].as_bool().unwrap_or(false), approvals: agent["approvals"].as_u64().unwrap_or(0) };
                    total += now.approvals;
                    let before = st.agents.get(&key).cloned().unwrap_or_default();
                    if now.approvals > 0 {
                        // Name the waiting tool calls we have not announced yet.
                        let doc = get_json(&format!("{backend}/v1/sessions/{sid}/agents/{aid}/docs/demo.approvals"), &token);
                        for item in doc.as_ref().and_then(|d| d["value"]["items"].as_object()).into_iter().flatten().map(|(_, v)| v) {
                            if item["status"] != "pending" {
                                continue;
                            }
                            let call = item["callId"].as_str().unwrap_or_default().to_string();
                            if st.notified.insert(call) && st.first_poll_done {
                                let summary = item["summary"].as_str().unwrap_or("").chars().take(160).collect::<String>();
                                events.push((format!("🔐 Freigabe nötig: {}", item["tool"].as_str().unwrap_or("tool")), format!("{sname} · {aname}"), summary, Some(key.clone())));
                            }
                        }
                    }
                    if before.busy && !now.busy && st.first_poll_done && now.approvals == 0 {
                        events.push(("✓ Agent ist fertig".into(), format!("{sname} · {aname}"), "Klicken zum Öffnen".into(), Some(key.clone())));
                    }
                    seen_now.insert(key, now);
                }
            }
            st.agents = seen_now;
            st.pending = total;
            st.first_poll_done = true;
            if let Some((.., target)) = events.last() {
                st.last_target = target.clone();
            }
        }

        // Agent-finished notifications only when the window is not in front.
        let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
        for (title, subtitle, message, target) in events {
            if title.starts_with('✓') && focused {
                continue;
            }
            notify(&app, &title, &subtitle, &message, target);
        }

        let status = match (tree.is_some(), hub_up) {
            (true, true) => format!(
                "● Läuft · Kev {}",
                if judge != "systemone" { "–" } else if judge_up { "✓" } else { "✗" }
            ),
            _ => "○ Startet oder gestoppt …".to_string(),
        };
        let approvals = if total == 0 { "Keine offenen Freigaben".to_string() } else { format!("🔐 {total} offene Freigabe{} öffnen", if total == 1 { "" } else { "n" }) };
        let (menus, tray, app2) = (menus.clone(), tray.clone(), app.clone());
        let _ = app.run_on_main_thread(move || {
            let _ = menus.status.set_text(&status);
            let _ = menus.approvals.set_text(&approvals);
            let _ = menus.approvals.set_enabled(total > 0);
            let _ = menus.demo_open.set_text(if demo_up { "Incident-Demo öffnen" } else { "Incident-Demo starten" });
            let _ = menus.demo_stop.set_enabled(demo_up);
            let _ = tray.set_title(if total > 0 { Some(format!("{total}")) } else { None });
            if let Some(w) = app2.get_webview_window("main") {
                let _ = w.set_badge_count(if total > 0 { Some(total as i64) } else { None });
            }
        });
        thread::sleep(POLL);
    }
}

/// Start the stack, then swap the loading page for the web UI.
fn start_stack(app: AppHandle, ctx: Ctx, restart: bool) {
    thread::spawn(move || {
        let args: &[&str] = if restart { &["start", "--detach", "--restart"] } else { &["start", "--detach"] };
        let out = ctx.dpi(args);
        let deadline = Instant::now() + Duration::from_secs(300);
        while !up(HUB) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(500));
        }
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let w = main_window(&handle);
            if up(HUB) {
                if let Ok(url) = HUB.parse() {
                    let _ = w.navigate(url);
                }
            } else {
                let text = out.replace('\\', "\\\\").replace('`', "'").replace('$', "");
                let _ = w.eval(&format!(
                    "document.getElementById('status').innerText = `Start fehlgeschlagen. Ausgabe von scripts/dpi.sh:\\n\\n{text}`"
                ));
            }
        });
    });
}

fn main() {
    let root = repo_root();
    let ctx = Ctx { path: login_path(), root };
    let state = Arc::new(Mutex::new(State::default()));

    let app = tauri::Builder::default()
        .setup({
            let ctx = ctx.clone();
            let state = state.clone();
            move |app| {
                #[cfg(target_os = "macos")]
                {
                    let _ = mac_notification_sys::set_application(&app.config().identifier);
                }
                let handle = app.handle().clone();
                show(&handle);

                let status = MenuItem::with_id(app, "status", "○ Startet …", false, None::<&str>)?;
                let open = MenuItem::with_id(app, "open", "Durable Pi öffnen", true, Some("CmdOrCtrl+O"))?;
                let approvals = MenuItem::with_id(app, "approvals", "Keine offenen Freigaben", false, None::<&str>)?;
                let demo_open = MenuItem::with_id(app, "demo", "Incident-Demo starten", true, None::<&str>)?;
                let demo_stop = MenuItem::with_id(app, "demo-stop", "Incident-Demo stoppen", false, None::<&str>)?;
                let restart = MenuItem::with_id(app, "restart", "Backend und Oberfläche neu starten", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Beenden (stoppt alles)", true, Some("CmdOrCtrl+Q"))?;
                let menu = Menu::with_items(
                    app,
                    &[
                        &status,
                        &PredefinedMenuItem::separator(app)?,
                        &open,
                        &approvals,
                        &PredefinedMenuItem::separator(app)?,
                        &demo_open,
                        &demo_stop,
                        &PredefinedMenuItem::separator(app)?,
                        &restart,
                        &quit,
                    ],
                )?;
                let menus = Arc::new(Menus { status, approvals, demo_open, demo_stop });

                let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
                let tray = TrayIconBuilder::with_id("main")
                    .icon(icon)
                    .icon_as_template(true)
                    .tooltip("Durable Pi")
                    .menu(&menu)
                    .show_menu_on_left_click(true)
                    .on_menu_event({
                        let ctx = ctx.clone();
                        let state = state.clone();
                        move |app, event| match event.id().as_ref() {
                            "open" => show(app),
                            "approvals" => {
                                let target = state.lock().unwrap().last_target.clone();
                                match target {
                                    Some(t) => open_agent(app, &t),
                                    None => show(app),
                                }
                            }
                            "demo" => {
                                let (app, ctx) = (app.clone(), ctx.clone());
                                thread::spawn(move || {
                                    if !up(&format!("{DEMO}/api/config")) {
                                        ctx.dpi(&["demo", "--detach"]);
                                    }
                                    let handle = app.clone();
                                    let _ = app.run_on_main_thread(move || open_demo(&handle));
                                });
                            }
                            "demo-stop" => {
                                if let Some(w) = app.get_webview_window("demo") {
                                    let _ = w.close();
                                }
                                let ctx = ctx.clone();
                                thread::spawn(move || {
                                    ctx.dpi(&["demo-stop"]);
                                });
                            }
                            "restart" => {
                                let w = main_window(app);
                                let _ = w.navigate("tauri://localhost/index.html".parse().unwrap());
                                start_stack(app.clone(), ctx.clone(), true);
                            }
                            "quit" => app.exit(0),
                            _ => {}
                        }
                    })
                    .build(app)?;

                start_stack(handle.clone(), ctx.clone(), false);
                let (state, menus, handle) = (state.clone(), menus.clone(), handle.clone());
                thread::spawn(move || poll(handle, state, menus, tray));
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the app");

    app.run(move |app, event| match event {
        // Dock icon: bring the window back, on the agent the latest notification was about.
        RunEvent::Reopen { .. } => {
            let target = state.lock().unwrap().last_target.take();
            match target {
                Some(t) => open_agent(app, &t),
                None => show(app),
            }
        }
        // Quit (menu, ⌘Q): stop what runs, so nothing is left behind.
        RunEvent::Exit => {
            ctx.dpi(&["stop"]);
        }
        _ => {}
    });
}
