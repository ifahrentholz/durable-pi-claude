# Flow Dashboard – Technisches Design (Phase 0 und Grundlage für alles Weitere)

Setzt `docs/flow-dashboard-spec.md` um. Die Spezifikation sagt *was*, dieses Dokument *wie*: Bausteine, Datenmodell,
die API für Clients, das Protokoll zwischen Server und Workern, Replikation, Sicherheit, Tests. Abschnittsverweise
wie „Spec 9.3“ beziehen sich auf die Spezifikation.

---

## 1. Bausteine und Repo-Layout

Alles TypeScript auf Node 24, wie der Rest des Repos. Keine neuen Grundtechnologien: express, `node:sqlite`, zod,
Vue 3 + Vite, pi-durable, Tauri 2.

| Paket | Rolle | Woher |
|---|---|---|
| `apps/flow-core` | Gemeinsame Typen und reine Logik: Konfig-Schema (zod, versioniert), Lanes und Pläne, Review-Policy, Shell-Guard, „Braucht dich“-Regeln, Farb-/Statuslogik, Protokoll-Typen Server↔Worker und Server↔Client | `jira-flow-be`: `lanes.ts`, `review-policy.ts`, `shell-guard.ts`, `types.ts` |
| `apps/flow-server` | Team-Instanz: DB, Auth, Projekte, Jira-Poller, Kev-Client, Dispatch, MR-/Pipeline-Watcher, Outbox für Jira/GitLab, Worker-API, Client-API, Realtime, Replikat-Speicher, Reports, liefert `flow-web` aus | neu; Jira-/Klassifikations-Teile aus `jira-flow-be` (`poller`, `classify`, `judge`, `mapping`) |
| `apps/flow-web` | Die Oberfläche (eine für Browser und Tauri) | aus dem Mockup; Entwickler-Komponenten aus `dpi-playground-fe` übernommen (Inspector, ApprovalCard, ContextBar, ModelPicker, Composer, TranscriptItem), Feed und Ticket-Karte nach `jira-flow-fe` |
| `apps/flow-worker` | Läuft **im** `dpi-backend` (geladen, wenn `FLOW_SERVER_URL` gesetzt ist): Verbindung zum Server, Aufträge, Leases, Ticket-Agent- und Reviewer-Extensions, Assistenten-Extensions, replizierender Speicher, Worktrees | `jira-flow-be`: `extensions.ts`, `repo.ts`, `ops.ts` (Ablauf), `cli.ts` |
| `apps/flow-desktop` | Tauri-Client (Phase 4) | nach Vorbild `apps/dpi-desktop` |
| `deploy/flow/` | `Containerfile`, `compose.yaml`, später `Caddyfile` | neu |
| `just/flow/` | `just flow up | down | logs | worker | migrate | test` | neu |

`jira-flow-be/-fe` bleiben auf `main` unverändert lauffähig; auf dem Pilot-Branch wandert ihr Code in die neuen
Pakete. Abgeschaltet wird der alte Flow erst, wenn Phase 2 ihn vollständig ersetzt.

**Warum der Worker im dpi-backend läuft:** Dort existieren schon Sessions, Harness-Registry, Approvals (Ask/Auto/YOLO),
Kompaktierung, Kev-Anbindung, Claude-Code-Provider und die v1-API, die die Inspector-Tabs brauchen. Der Flow-Worker
ergänzt nur Extensions und die Server-Verbindung. Jede Ticket-Ausführung ist eine dpi-Session mit eigenem Worktree als
Arbeitsverzeichnis.

## 2. Datenmodell (Server-DB)

SQLite (WAL) über `node:sqlite`, Migrationen als nummerierte SQL-Dateien, beim Start angewendet. Alle Zeitstempel in
ms, IDs als ULID (sortierbar) außer Jira-Keys.

| Tabelle | Inhalt (wichtigste Spalten) |
|---|---|
| `users` | id, email, name, role (`pm`/`dev`), language, notifications (JSON), jira_account_id |
| `auth_sessions` | id, user_id, expires_at (Web-Cookie) |
| `api_tokens` | id, user_id, name, hash, last_used_at (Tauri-App) |
| `invites` | token_hash, email, role, expires_at |
| `projects` | key (PK), name, config (JSON, `schemaVersion`), created_by, archived_at |
| `project_members` | project_key, user_id, role |
| `secrets` | id, owner (`project:SHOP:jira`, `project:SHOP:repo:storefront`), ciphertext, nonce, key_version |
| `workers` | id, name, kind, owner_user_id, slots, projects (JSON), accept_auto, judge, version, last_seen_at, state (`online`/`offline`/`limited`), limited_until |
| `worker_keys` | worker_id, hash, revoked_at; `join_tokens` (einmalig) |
| `tickets` | key (PK), project_key, jira (JSON: Titel, Beschreibung, Typ, Status, Statuskategorie, Priorität, Rang, Labels, Assignee, updated), flow_stage, lane, kev (JSON), scoped, ready, found_at, updated_at |
| `ticket_seen` | ticket_key, user_id, seen_at (NEU je Benutzer, Spec 6.1) |
| `runs` | id, ticket_key, kind (`ticket`, `rework`), worker_id, **epoch**, state, plan (JSON), model, permission_mode, compaction (JSON), created_by, lease_expires_at, heartbeat_at, branch, last_pushed_sha, mr (JSON), started_at, ended_at. **Eindeutiger Index auf `ticket_key` für nicht beendete Läufe** |
| `run_agents` | run_id, agent (`main`, `review-<n>`), conversation_id (beim Worker), model |
| `run_events` | run_id, seq, type, payload (JSON), at – Verlauf und Quelle für den Realtime-Stream |
| `reviews` | id, run_id, round, attempt, commit_sha, verdict, findings (JSON), gates (JSON) |
| `approvals` | id, run_id, agent, tool, input (JSON), reason, state (`pending`/`allowed`/`denied`), decided_by, rule |
| `replica_commits` | run_id, seq, epoch, writes (komprimiertes JSON), at – siehe 5 |
| `assistant_threads` | id, user_id, kind (`desk`/`draft`/`refine`), scope (Projekt oder alle, Ticket), worker_id, conversation_id |
| `usage` | run_id oder thread_id, agent, model, input/output/cache-Tokens, cost_usd, at |
| `outbox` | id, target (`jira`/`gitlab`), op, payload (JSON), idempotency_key, attempts, next_at, state, last_error |
| `watches` | run_id, mr_iid, state (`open`/`merged`/`pipeline`/`green`/`red`), merge_sha, pipeline_id, checked_at |
| `notifications` | id, user_id, type, ref, read_at, at |
| `audit` | wer, was, worauf, wann (alle schreibenden Aktionen) |

**Regeln, die die DB erzwingt:** ein offener Lauf je Ticket (Index), Lease-Updates nur mit passender Epoche
(`UPDATE … WHERE id = ? AND epoch = ?`), Replikat-Commits nur mit aktueller Epoche, Outbox-Einträge eindeutig über
`idempotency_key`.

## 3. Client-API (`/api/v1`)

REST mit JSON, Fehlerform wie dpi-backend (`{error:{code,message}}`), Idempotenz-Header für alle anlegenden und
startenden Aufrufe. Auth: Cookie (Web) oder `Authorization: Bearer <api-token>` (Tauri).

**Realtime:** `GET /api/v1/stream?topics=…` (SSE), Muster `hello → snapshot → deltas` wie dpi-backend. Topics:
`projects`, `project:<key>` (Tickets, Läufe, Zähler), `run:<id>` (Transkript-Einträge, Live-Generierung, Tasks,
Freigaben), `thread:<id>`, `me` (Mitteilungen). Nach einem Reconnect kommt ein frischer Snapshot.

| Bereich | Routen (Auswahl) |
|---|---|
| Auth | `POST /auth/invite/:token` (Konto anlegen), `POST /auth/login`, `POST /auth/logout`, `GET/POST/DELETE /me/tokens` |
| Ich | `GET/PATCH /me` (Sprache, Mitteilungen), `GET /me/notifications`, `POST /me/notifications/read` |
| Projekte | `GET/POST /projects`, `GET/PATCH/DELETE /projects/:key`, `POST /projects/:key/test-connection`, `GET /projects/:key/board` (Spalten aus Jira) |
| Tickets | `GET /projects/:key/tickets?group=&lane=&prio=&q=` · `GET /tickets/:key` · `POST /tickets/:key/release` / `unrelease` · `PATCH /tickets/:key` (priority, lane) · `POST /tickets/:key/rank` `{before|after}` · `POST /tickets` (anlegen) · `POST /tickets/:key/seen` |
| Ablauf | `POST /tickets/:key/start` `{worker?, model?}` · `POST /tickets/:key/done` · `POST /tickets/:key/findings` (multipart mit Screenshot) |
| Assistenten | `POST /threads` `{kind, scope, ticket?}` · `POST /threads/:id/messages` · `POST /threads/:id/apply` (Schärfen → Jira, Entwurf → Ticket anlegen) |
| Läufe (Dev) | `GET /runs/:id` · `GET /runs/:id/agents/:a/entries` · `POST /runs/:id/agents/:a/messages` · `POST /runs/:id/abort` · `POST /runs/:id/approvals/:aid` `{decision, rule?}` · `PATCH /runs/:id` (model, permissionMode, compaction) · `PATCH /runs/:id/tools` · `PATCH /runs/:id/extensions` · `GET/PUT /runs/:id/state` · `GET /runs/:id/tasks`, `POST …/tasks/:t/abort` · `POST /runs/:id/handover` `{worker}` |
| Worker (Dev) | `GET /workers` · `POST /workers/join-token` · `PATCH/DELETE /workers/:id` |
| Reports | `GET /projects/:key/reports?from=&to=` (CFD, Durchsatz, Durchlaufzeit, Burnup, Kosten) |

Schreibende Lauf-Aktionen prüft der Server (Rolle `dev`), legt sie in `run_events` ab und reicht sie als Kommando an
den Worker weiter (siehe 4). Der Client sieht das Ergebnis über den Stream, nicht über die Antwort.

## 4. Worker-Protokoll (`/worker/v1`)

Nur ausgehende Verbindungen vom Worker; Auth mit dem Worker-Schlüssel (aus dem einmaligen Join-Token).

```
Worker                                   Server
  │ POST /hello {id, version, slots, projects, acceptAuto, judge,
  │             runs:[{runId, epoch, lastSeq}]}  ──────────▶ prüft Version, Epochen
  │ ◀──────────── {ok, fence:[runId…], resume:[runId…]}
  │ GET /stream (SSE)  ◀──── offer · command · ping
  │ POST /runs/:id/claim {epoch} ──▶ atomar: Lease (z. B. 60 s) oder 409
  │ POST /runs/:id/heartbeat {epoch}      alle 15 s, verlängert die Lease
  │ POST /runs/:id/events {epoch, events[]}   Stage, Freigabe angefragt, MR geöffnet,
  │                                           Usage, Fehler, „limitiert bis“
  │ POST /runs/:id/replicate {epoch, commits:[{seq, writes}]} ──▶ {ackSeq}
  │ GET  /runs/:id/replica?from=0        bei Übergabe: Replik zum Einspielen
  │ POST /judge {...}                    Kev-Proxy für den Auto-Modus
```

- **Angebote:** Der Dispatch (manuell oder automatisch) wählt einen Worker und schickt `offer {runId, epoch, job}`.
  Der Job enthält alles zum Starten: Ticket-Snapshot (Titel, Beschreibung, Akzeptanzkriterien, Lane, Plan,
  Scope), Repo-Ziel, Branch, Modell, Permission-Modus, Kompaktierung, Extensions, Brief. Der Worker antwortet mit
  `claim`; erst dann gilt der Lauf als gestartet. Ohne Claim innerhalb von 30 s geht das Angebot zurück.
- **Kommandos** (Server → Worker): `message`, `abort`, `approval` (Entscheidung), `configure` (Modell, Modus,
  Kompaktierung, Tools, Extensions), `state` (App State schreiben), `pause`, `fence` (sofort stoppen: neue Epoche
  woanders). Jedes Kommando trägt eine ID; der Worker bestätigt per `events` (`command.done`), doppelte IDs ignoriert
  er.
- **Ereignisse aus den Flow-Tools:** `update_ticket`, `confirm_scope`, `submit_fix` (mit `pushedSha`),
  `request_review`, `submit_review` (Befund), `open_mr` (MR-URL, iid), `answer_question` melden sich als Ereignis; der
  Server führt die Stage, schreibt Jira über die Outbox und startet Folgeschritte (z. B. Review als neuer Agent im
  selben Lauf auf demselben Worker).
- **Lease und Fencing (Spec 9.3):** Läuft die Lease ab, setzt der Server den Lauf auf `paused` – ohne Neuvergabe.
  `handover` erhöht die Epoche und bietet den Lauf einem anderen Worker an; der alte bekommt beim nächsten Kontakt
  `fence` und stoppt. Jeder Aufruf mit alter Epoche erhält `409 fenced`.
- **Wiederanlauf:** Nach Neustart meldet der Worker in `hello` seine Läufe mit Epoche und letzter bestätigter
  Commit-Nummer; der Server antwortet mit `resume` (weitermachen, Replikation ab `lastSeq` nachholen) oder `fence`.
- **Abo-Limits:** Erkennt der Worker ein Rate-Limit des Claude-Codes, meldet er `limited {until}`; der Server setzt
  den Worker auf `limited`, zeigt den Grund am Ticket, der Dispatch überspringt ihn (Spec 14).

## 5. Replikation der Agenten-Daten (Spec 9.2)

- **Hülle um den Speicher:** `ReplicatingStorage implements Storage` delegiert an `openNodeSqliteStorage` des Workers.
  Nach jedem erfolgreichen `commit(writes)` legt sie `{seq, writes}` in eine lokale Warteschlange (eigene
  SQLite-Tabelle im Worker, damit nichts bei einem Absturz verloren geht). Ein Uploader schickt sie gebündelt (alle
  250 ms oder 64 Commits) an `/replicate`; der Server bestätigt die höchste lückenlose Nummer (`ackSeq`).
- **Warum die Hülle statt `subscribeCommits`:** Sie sieht genau die `StorageWrite`-Liste, die die Harness schreibt,
  und lässt sich 1:1 in einen anderen Speicher wieder einspielen. `subscribeCommits` liefert nur Änderungs-Hinweise.
- **Server-Seite:** `replica_commits` als Log; daneben je Lauf eine Replikat-SQLite (gleiches pi-durable-Schema), in
  die der Server die Commits einspielt. Lesen (Transkript, Einträge, Tasks, Dokumente) läuft über die Storage-API
  dieser Replik; die Transkript-Aufbereitung übernimmt den Code von dpi-backend (`history.ts`, SDK-Transcript).
- **Wiederherstellen:** Ein neuer Worker holt `/replica?from=0`, spielt die Commits in eine frische lokale DB ein (der
  ID-Zähler des sqlite-Backends folgt den geschriebenen Datensätzen), öffnet darauf die Harness und setzt mit dem
  Hinweis aus Spec 9.2 fort; Worktree vom gepushten Branch (`last_pushed_sha`).
- **Volumen:** Live-Generierung schreibt häufig (Fortschritt alle 100 ms). Bündelung und gzip halten das klein; die
  Aufbewahrung (Spec 12) räumt das Log von erledigten Läufen auf, die Replik bleibt für das Transkript.

## 6. Abläufe im Server

- **Poller** je Projekt: JQL `project = X AND labels = <readyLabel> …` plus `updated >= letzter Poll` für Änderungen
  an bekannten Tickets; neue Tickets → Kev → `tickets`; Änderungen an laufenden Tickets → Reaktionen nach Spec 9.5.
- **Kev-Client:** wie `jira-flow-be/judge.ts`, Ziel aus der Umgebung (`KEV_URL=http://host.containers.internal:8009`);
  Fehler → Heuristik mit Hinweis. Derselbe Client bedient `/worker/v1/judge`.
- **Dispatch:** Ereignis-getrieben (Freigabe, Lauf beendet, Worker online, WIP-Änderung) plus Takt alle 10 s. Für
  `auto`-Projekte: Tickets nach `priority, rank, created`, nur startklare, solange `wipLimit` nicht erreicht; Worker
  mit freiem Slot, `acceptAuto`, nicht `limited`, Projekt erlaubt. Start immer über dieselbe atomare Funktion wie der
  manuelle Start.
- **Watcher:** offene MRs alle 60 s über die GitLab-API (Lese-Token); gemerged → Pipeline des Merge-Commits auf dem
  Ziel-Branch verfolgen (optional bestimmte Jobs) → `test` bzw. `pipefail`.
- **Outbox:** Alle Jira- und GitLab-Schreibzugriffe des Servers (Kommentar, Transition, Label, Priorität, Rang,
  Zuweisung, Beschreibung) laufen über `outbox` mit Idempotenz-Schlüssel und Backoff; so überstehen sie Ausfälle und
  doppelte Ereignisse. Status im UI: „Jira-Änderung ausstehend“.
- **Jira-Adapter:** REST v3 direkt (Basic Auth mit E-Mail und Token), ADF für Beschreibung und Kommentare
  (Markdown→ADF-Konverter im Server), Agile-API für Rang und Board-Konfiguration, Transitions über
  `statusCategory`, `accountId` per `/user/search?query=<email>`.

## 7. Worker im Detail

- **Laden:** `dpi-backend` lädt `flow-worker`, wenn `FLOW_SERVER_URL` und ein Worker-Schlüssel gesetzt sind. Ohne
  diese Variablen ändert sich nichts am heutigen Verhalten.
- **Ein Lauf = eine dpi-Session** mit dem Worktree als `cwd`, eigener Registry (Coding-Tools, `ticket-agent`,
  `flow-reviewer`, Approvals, Projekt-Kontext) und `ReplicatingStorage`. Der Reviewer ist ein zweiter Agent derselben
  Session (eigene Conversation, gepinntes Modell, Read-only-Hook).
- **Flow-Tools** wie heute in `jira-flow-be/extensions.ts`, aber statt in ein lokales Ticket-Dokument zu schreiben,
  melden sie Ereignisse an den Server; Prüfungen (Lane, Stage, Review bestanden) bekommen sie aus dem Job und den
  Server-Antworten. `submit_fix` committet **und pusht** den Branch; `open_mr` öffnet bzw. aktualisiert den MR.
- **Assistenten** (Entwurf, Schärfen, Flow Desk) sind eigene dpi-Sessions ohne Coding-Tools, mit lesenden Tools gegen
  die Server-API (im Namen des Benutzers, Rechte prüft der Server).
- **Inspector-Tabs** nutzen die vorhandene v1-Logik von dpi-backend; der Server reicht `configure`/`state`/`tasks`-
  Kommandos durch und liest Ergebnisse aus der Replik.

## 8. Sicherheit

- Passwörter entfallen im Pilot: Einladungslink → Konto → Session-Cookie (`HttpOnly`, `SameSite=Lax`, `Secure` hinter
  TLS); API-Tokens und Worker-Schlüssel nur als Hash gespeichert.
- Geheimnisse (Jira-, GitLab-Tokens) mit AES-GCM und `FLOW_SECRET_KEY` aus der Umgebung; Schlüsselversion für Rotation.
- CSRF: Cookie-Requests nur mit `Origin`-Prüfung (wie heute im Jira Flow); CORS aus.
- Rollenprüfung zentral pro Route (`requireRole('dev')` für Lauf- und Worker-Routen, Permission-Modus).
- Worker dürfen nur ihre eigenen Läufe sehen und ändern; Assistenten-Tools laufen mit den Rechten des Benutzers.
- Tickets sind nicht vertrauenswürdig (Spec 14): Brief und Ticket-Inhalt gehen als Nutzerinhalt an den Agenten,
  Shell-Guard und Approvals bleiben aktiv, YOLO nur je Session durch Entwickler.

## 9. Tests

- **flow-core:** Unit-Tests (node:test) – Pläne, Review-Policy, Shell-Guard (vorhandene Tests wandern mit), Zähler-
  und Farb-Regeln, Konfig-Migrationen.
- **flow-server:** Integrationstests gegen eine Test-DB mit **Fake-Jira** und **Fake-GitLab** (kleine express-Server
  mit Fixture-Daten) und einem Fake-Kev. Schwerpunkte: atomarer Start (parallele Starts → ein Lauf), Lease-Ablauf →
  `paused`, Fencing (alte Epoche → 409), Outbox-Wiederholung, Poller-Reaktionen nach Spec 9.5, WIP-Limit.
- **Worker + Server:** End-to-End mit dem vorhandenen **Faux-Provider** von dpi-backend (deterministisch, kostenlos):
  Ticket → Lauf → Review → MR (gegen Fake-GitLab) → Jira-Kommentar; Worker mit `kill -9` mitten im Lauf → Wiederanlauf;
  Übergabe an zweiten Worker mit Replik.
- **flow-web:** Playwright gegen Server + Faux-Worker, die Abläufe aus dem Mockup als Testfälle.

## 10. Spikes vor dem Bau (Phase 0, je 0,5–2 Tage)

| | Frage | Erfolg, wenn |
|---|---|---|
| S1 | Replikation und Wiederherstellen einer pi-durable-Session über die Speicher-Hülle | ein laufender Agent wird auf einer zweiten Maschine aus der Replik fortgesetzt, Transkript identisch |
| S2 | Kev aus dem Container auf dem Host | Klassifikation aus dem Container in < 2 s |
| S3 | Jira Cloud REST v3 mit Token | Rang setzen, Transition über statusCategory, ADF-Beschreibung ändern, Zuweisen per accountId – an einem Testticket |
| S4 | GitLab-Lese-API | gemergten MR und die Pipeline seines Merge-Commits sicher erkennen |
| S5 | Abo-Limit im Claude-Code-Provider | Rate-Limit-Fehler eindeutig erkennen und „limitiert bis“ ermitteln |
| S6 | Server-Replik als Transkript-Quelle | Transkript aus der Replik entspricht dem von dpi-backend |
