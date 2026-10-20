# Flow Dashboard – Spezifikation (Pilot)

Stand: Branch `pilot/flow-dashboard`. Hält alle Entscheidungen aus den Mockup-Runden fest und listet, was vor der
Umsetzung noch entschieden werden muss. Das klickbare Mockup ist `docs/flow-dashboard-mockup.html`; wo dieses Dokument
und das Mockup sich widersprechen, gilt dieses Dokument.

`docs/jira-flow-architecture.md` ist die erste Skizze des Jira Flows und in mehreren Punkten überholt (ein
Jira-Kommentar je Stage, Status-Übergänge, Freigabe vor dem Mergen als Standard). Der Jira Flow auf `main`
(`apps/proactive-dpi-demo/apps/jira-flow-be`, README dort) ist der Ist-Stand, auf dem das Dashboard aufsetzt.

---

## 1. Ziel

Eine Anwendung für Projektarbeit mit Agenten: Product Owner und Projektmanager steuern (priorisieren, freigeben,
klären, testen, Fortschritt sehen), Entwickler steuern zusätzlich die Agenten. Mehrere Projekte. Erreichbar als
Tauri-App, im Browser, auf dem Handy und im Terminal – eine API, viele Clients, wie bei Durable Pi.

Nicht im Pilot: die Shop-/Incident-Demo (bleibt, wie sie ist), SSO, Server-Worker im Betrieb, Auto-Merge.

## 2. Grundsätze

1. **Jira ist die Quelle der Wahrheit** für Tickets, Priorität, Rangfolge, Labels, Status und Historie. Was ein
   Mensch im Dashboard am Ticket ändert, geht direkt nach Jira. Der Flow-Server hält den Flow-Zustand (Stage,
   Zuweisung, Reviews, Freigaben) und eine laufend synchronisierte Kopie der Agenten-Daten (siehe 9.2).
2. **Jira-Kommentare nur an zwei Stellen:** beim Öffnen eines MR (ein Satz zum Fix plus Link) und beim manuellen
   Erledigen (wer es erledigt hat). Risiken stehen im MR. Beschreibung und Akzeptanzkriterien ändert nur ein Mensch
   ausdrücklich („Ticket schärfen“). Status-Übergänge sind keine Kommentare (siehe 9.4).
3. **Rechte prüft der Server**, nicht die UI.
4. **Ein Ticket hat höchstens einen aktiven Agenten-Lauf**, und er bleibt auf seinem Worker (siehe 9.3).
5. **Claude-Zugangsdaten verlassen den Worker nicht.** Jeder Worker läuft mit dem Abo seines Besitzers; der
   Flow-Server speichert keine Claude-Credentials.
6. **Jira- und GitLab-Zugriffe sind getrennt:** Jira spricht nur der Flow-Server (Token je Projekt), git und GitLab
   nur der Worker (mit `git`/`glab` seines Besitzers).
7. **Eine Farbsprache**, überall gleich (siehe 6.2).

## 3. Architektur

```
Clients (Tauri · Browser · Handy · flow-tui) ── Login, Rolle, Realtime-Stream ──▶ Flow-Server (Team-Instanz, Container)
                                                                                   ├─ DB: Projekte, Benutzer, Tickets/Flow-Zustand,
                                                                                   │      Läufe, Reviews, Freigaben, Leases
                                                                                   ├─ je Projekt: Jira-Poller, Kev, Dispatch,
                                                                                   │      MR-/Pipeline-Watcher, Reports
                                                                                   └─ Worker-API (nur ausgehend vom Worker)
                                                                                         ▲ holt Aufträge, meldet Status
                                                                   Worker = dpi-backend + Flow-Agent (Entwickler-Rechner, später Server)
                                                                   Ticket-Agenten, Reviewer, Worktrees, git/glab, Claude-Abo, lokale
                                                                   pi-durable-DB (Transkripte, durable Tasks)
Jira Cloud · GitLab · Kev (auf dem Host, siehe 9.6)
```

- **Pilot lokal:** Flow-Server als Container (Podman oder Docker Compose) auf dem Mac, verhält sich wie auf einer VM.
  Worker und Kev laufen auf dem Host. Später zieht der Container unverändert auf einen Server.
- **Clients:** Web-UI (responsiv, später PWA), Tauri-App (Mitteilungen, Dock-Badge, Menüleiste, optional lokalen
  Worker starten – wie `apps/dpi-desktop`), Terminal-Client analog `dpi-tui`.
- **Login:** Einladungs-Accounts im Pilot, SSO (GitLab-OAuth) später.
- **Sprache:** Deutsch und Englisch, je Benutzer umschaltbar; alle Texte aus einem Katalog. Das Mockup ist deutsch.

## 4. Rollen

Phase 1: **jeder darf alles in Projekten** (anlegen, Mitglieder, Einstellungen, Lane ändern, freigeben, erledigen).
Die Unterscheidung PM/PO ↔ Entwickler bleibt für die Agenten:

| | PM / PO | Entwickler |
|---|---|---|
| Projekte, Einstellungen, Mitglieder, Priorität, Rangfolge, Freigabe, Lane, Tickets anlegen und schärfen | ✓ | ✓ |
| Klärung beantworten, Testen, Findings, als erledigt markieren, Reports, Kosten | ✓ | ✓ |
| Agent-Chat, Start, Modell, Session/State/Tasks/Tools/Extend, Tool-Freigaben | – | ✓ |
| **Permission-Modus ändern** (Ask/Auto/YOLO) | – | ✓ |
| Worker verbinden | – | ✓ |

Die Rolle ist im Pilot eine Eigenschaft des Benutzers (nicht je Projekt). In Phase 1 übernehmen Entwickler die
PO-Rolle zum Testen.

## 5. Aufbau der Oberfläche

Ein Bildschirm, drei Spalten, im Design der bestehenden Apps (Jira-Flow-UI, Durable-Pi-Hub): dichte Mono-Tabellen,
Stat-Leiste, Pills, Stepper-Balken, Tool-Karten, Composer, Bewegung (Puls, Einblenden neuer Zeilen).

**Kopfzeile:** Logo · Fokus-Auswahl (Alle Projekte | ein Projekt) · Polling-Ring mit Countdown · Kev-Status ·
Worker-Status (nur Dev) · Zugriffswege/Hilfe · „+ Ticket“ · Konto.

**Links – Baum**
- *Fokus auf ein Projekt:* nur dessen Tickets, gruppiert: Braucht dich · Agents arbeiten · Läuft sonst · Erledigt.
- *Alle Projekte:* aufklappbare Projektliste mit ihren laufenden Tickets.
- *Entwickler:* Umschalter Projekte | Netzwerk. Netzwerk = Worker → Ticket-Session → Agenten (Main, Review #n), mit
  Slots („2/3“). Ticket-Zeilen tragen das Worker-Kürzel. „+“ verbindet in der Netzwerk-Sicht einen Worker, sonst
  legt es ein Projekt an.

**Mitte:** Feed · Board · Reports · Einstellungen; für Entwickler zusätzlich die Inspector-Tabs des gewählten
Agenten: Session · State · Tasks · Tools · Extend. Ohne Fokus: Projektübersicht.

**Rechts:** das gewählte Ticket (Karte mit Lane-Stepper, Status, Zusammenfassung, aufklappbarer Jira-Inhalt), darunter
je nach Lage: Klärung, Ticket schärfen, Testen, Verlauf und Aktionen; für Entwickler die Tabs Ticket · Main ·
Review #n. Ohne Auswahl: Flow Desk. „+ Ticket“ öffnet hier den Ticket-Assistenten.

**Handy:** eine Spalte, Tab-Leiste unten (Projekte · Feed · Ticket).

## 6. Regeln

### 6.1 Braucht dich (rote Zahl)

| Rolle | zählt |
|---|---|
| PM/PO | neue Tickets (siehe unten) · Klärungen · Bereit zum Testen |
| Entwickler | neue Tickets · Bereit zum Testen · MR wartet auf Code-Review · Tool-Freigabe · Hilfe nötig · Pipeline rot · pausiert |

„▸n“ daneben: aktiv arbeitende Agenten. Keine Projekt-Tags.

**Neu:** ein Ticket, das der Poller gefunden hat und das *du* noch nicht geöffnet oder freigegeben hast (NEU-Marke im
Feed). Der Gelesen-Zustand gilt je Benutzer, wie bei E-Mail.

### 6.2 Farben (Punkte, Status, Karten)

| | Bedeutung |
|---|---|
| Rosa, pulsierend | ein Agent arbeitet |
| Gelb | wartet auf einen Menschen (Klärung, Test, Entscheidung, MR) |
| Rot mit Ring, ohne Puls | blockiert oder pausiert |
| Grün | fertig |
| Grau | ruhig |

Ein Projektpunkt zeigt den dringendsten Zustand seiner Tickets: Rot > Gelb > Rosa > Grün > Grau.

### 6.3 Lanes (wie Jira Flow auf `main`)

question → beantwortet · quick → implement → review → MR · ticket → implement → review → MR · feature → Klärung →
implement → review → MR. Nach dem MR: Gemerged · Pipeline → Testen → Erledigt (siehe 7.6).

## 7. Funktionen

### 7.1 Projekte
- Anlegen: Jira-Projekt-Key (Duplikatprüfung), Name, Jira-Token, GitLab-Repo, Ziel-Branch, Branch-Schema,
  Start der Agenten (manuell | automatisch), Mitglieder.
- Einstellungen: Name, Label für „freigegeben“, Mitglieder und Rollen; nur Entwickler: Repo, Branch, Schema,
  Test-Befehl, Standard-Permissions, Reviewer-Modell und Review-Versuche.
- Projektübersicht: Offen, In Arbeit, Braucht dich, Erledigt, Fortschritt, Projektpunkt.

### 7.2 Feed
- Stat-Leiste: ready · needs clar. · in progress · waiting you · done · blocked.
- Angeheftet: alle gestarteten, nicht erledigten Tickets mit Status.
- Tabelle: gefunden um · Priorität (Klick ändert sie in Jira) · Ticket (NEU-Marke) · Kev/Status · Freigabe-Schalter
  (setzt das Jira-Label). Ziehen ändert die Rangfolge in Jira.
- **Filter** (Feed und Board): Suche nach Key oder Titel · Gruppe (Offen, Braucht dich, Neu, In Arbeit, Testen,
  Erledigt, Alle, jeweils mit Anzahl) · Lane · Priorität; „x / y“ zeigt, wie viele der Filter übrig lässt.
- Polling: neue Tickets gleiten ein, der Kev-Chip pulsiert, bis Kev entschieden hat.
- Lane ist vor dem Start in der Ticket-Karte änderbar (jeder).

### 7.3 Ticket schärfen (vor dem Start)
Für Tickets, die Kev als zu vage einstuft. Ein Assistent **ohne Code-Zugriff** fragt nach (eine Frage, Empfehlung,
Alternative, freie Antwort), Kev bewertet live neu. „In Jira aktualisieren“ schreibt Beschreibung und
Akzeptanzkriterien (Bearbeiten, kein Kommentar). Bleibt Kev bei „zu vage“, wird weiter geschärft. Ein so
geschärftes Feature startet ohne zweite Klärung. Der aufklappbare Jira-Inhalt zeigt die neuen Kriterien als
„+ neu“, bevor sie gespeichert werden.

### 7.4 Klärung (Grill im Agenten)
Für Features und vage Tickets, die ungeschärft gestartet wurden. Der Agent fragt den PO in der Session, eine Frage
nach der anderen mit Empfehlung; „Scope bestätigen“ beendet die Klärung (`confirm_scope`). Kein Slot belegt.

### 7.5 Ticket-Assistent
Beschreibung in eigenen Worten → Rückfragen → Entwurf mit Akzeptanzkriterien und Kev-Bewertung → „In Jira anlegen“,
optional gleich freigeben.

### 7.6 Nach dem MR: Pipeline, Testen, Erledigt
- **Watcher:** Der Flow-Server beobachtet den MR (Polling; Webhook, sobald der Server für GitLab erreichbar ist).
  Ist er gemerged, wartet der Ticket-Status auf die Pipeline des Merge-Commits auf dem Ziel-Branch
  („Gemerged · Pipeline läuft“). Ist sie grün, geht das Ticket auf **Testen**; ist sie rot, auf **Pipeline rot**
  (Entwickler braucht es). Welche Pipeline bzw. welcher Job zählt (z. B. `deploy:dev`), ist je Repo einstellbar.
- **Erledigt nur manuell:** In „Testen“ prüft ein Mensch das Feature und markiert es als erledigt. Das setzt das
  Jira-Ticket auf Done und schreibt einen Kommentar „Als erledigt markiert von <Name> (Flow Dashboard)“.
- **Finding melden** (Schritte, erwartet, tatsächlich, Screenshot): an den bisherigen Agenten, sonst einen neuen; er
  arbeitet auf einem neuen Branch vom Ziel-Branch (`<Branch-Schema>-fix-<n>`, z. B. `feature/SHOP-138-fix-1`), der
  Screenshot geht als Bild an den Agenten, der neue MR verweist auf das Finding. Das Ticket bleibt bis zum nächsten
  Testen in „Nacharbeit“.

### 7.7 Kosten
Überall als **API-Äquivalent** (was es über die API kosten würde; das Abo selbst kostet nichts zusätzlich), für alle
sichtbar: je Ticket auf der Karte (Main, Review, Tokens), auf den angehefteten Tickets im Feed, je Projekt in der
Projektübersicht und in den Reports (Summe, Ø pro erledigtem Ticket, diese Woche, Anteil Reviews, Ø je Lane,
Modell-Anteile). Quelle: die Usage-Daten der Agenten, gemeldet von den Workern.

### 7.8 Reports (Kanban)
Fortschritt, Durchsatz je Woche, Durchlaufzeit (Median), Anteil der Agenten, Cumulative Flow, Burnup – berechnet aus
der Jira-Historie über die offizielle REST-API (die Chart-Endpunkte `greenhopper/rapid/charts` sind intern und nicht
unterstützt).

### 7.9 Agent-Werkzeuge (Entwickler)
- Chat mit Main (Follow-up/Steer, Interrupt), Review #n nur lesend; Ticket-Brief, Thinking, Tool-Karten live.
- Modell-Wähler am Chat-Chip und im Session-Tab: Kev-Empfehlung, kein Modell unter Sonnet für Code-Agenten,
  Reviewer fest auf Opus; gilt ab dem nächsten Schritt.
- Session: Modell, Thinking, Permissions Ask/Auto/YOLO, Auto-Compaction-Schwelle, Stats.
- State (App State des Tickets), Tasks (durable Tasks, abbrechen), Tools (an/aus, Read-only), Extend (Extensions).
- Start mit Worker-Wahl (offline Worker gesperrt).
- **Tool-Freigaben:** Im Modus Ask oder Auto hält ein Tool-Aufruf an, bis ein Entwickler entscheidet: Karte im
  Agent-Chat mit Befehl und Begründung (bei Auto die von Kev), „Erlauben“, „Immer erlauben“ (Regel für diese Session)
  und „Ablehnen“ (der Agent bekommt die Ablehnung und macht anders weiter). Das Ticket zählt bei Entwicklern unter
  „Braucht dich“, PMs sehen „Wartet auf Entwickler“. YOLO hebt weder den Flow-Guard noch den Read-only-Schutz des
  Reviewers auf.
- **Flow-Tools sind fest:** `update_ticket`, `confirm_scope`, `answer_question`, `submit_fix`, `request_review`,
  `open_mr` sind im Tools-Tab gesperrt (immer an, nicht abschaltbar), sonst bricht der Ablauf. Abschaltbar sind die
  Coding-Tools und Extensions.

### 7.10 Worker
Verbinden wie im Durable-Pi-Netz: dieser Rechner · Team-Rechner (SSH) · Server/VM · laufendes dpi-backend (URL);
Slots, Projekte, automatischer Dispatch ja/nein, Befehl. Offline-Worker pausiert seine Tickets. Kein Umzug
laufender Tickets im Pilot.

---

## 8. Konfiguration

Gespeichert in der Server-DB, versioniert (`schemaVersion`), als YAML/JSON export- und importierbar. Unbekannte
Felder bleiben erhalten, neue Felder haben Defaults – so wächst das Schema, ohne alte Projekte zu brechen. Die heutige
`jira-flow.config.json` wird beim ersten Start in ein Projekt übernommen.

```yaml
# Projekt
schemaVersion: 1
key: SHOP                              # Jira-Projekt-Key, eindeutig
name: Webshop Relaunch
jira:
  site: diva-e.atlassian.net
  project: SHOP
  credential: { kind: personal, user: max@… }   # später: { kind: service-account, ref: … }
  readyLabel: ready-for-agent
  jql: null                            # optionaler Zusatzfilter, z. B. component = Checkout
  board: 123                           # Kanban-Board: Spalten, Rangfolge
  statusMap:                           # Flow-Stage → Jira-Status; "auto" = über statusCategory erkannt
    started: auto                      # In Progress
    mrOpen: auto                       # In Review, falls vorhanden
    testing: auto                      # QA/Test, falls vorhanden
    done: auto                         # Done
repos:
  - id: storefront
    gitlab: { host: gitlab.example.com, path: shop/storefront }
    defaultBranch: develop
    branchTemplate: feature/{key}
    testCommand: npm run test
    pipeline: { waitFor: merge-commit, jobs: [] }   # leer = ganze Pipeline; sonst z. B. [deploy:dev]
routing: { repoLabelPrefix: "repo:" }  # Ticket-Label repo:<id> wählt ein anderes Repo
dispatch:
  mode: manual                         # manual | auto
  order: [priority, rank, created]     # Priorität, bei Gleichstand Jira-Rangfolge, dann Alter
agents:
  models: { simple: sonnet-5-5, moderate: sonnet-5-5, complex: opus-5-5, floor: sonnet-5-5 }
  thinking: high
  permissionMode: auto                 # Default neuer Agenten; ändern nur Entwickler
  compaction: { autoAt: 200000, reserve: 50000 }
  extensions: [coding-tools, ticket-agent]
review: { model: opus-5-5, maxAttempts: 2, quickLane: true }
merge: { auto: false, approvalMode: both }
lifecycle: { doneBy: human, doneComment: true }
members: [ { user: lena@…, role: pm }, { user: max@…, role: dev } ]
```

```yaml
# Worker
id: mac-max
name: MacBook Max
kind: local                            # local | ssh | exe-dev | url
owner: max@…
slots: 3
projects: all                          # oder [SHOP, APP]
dispatch: { acceptAuto: true }         # nimmt automatisch verteilte Tickets an
```

```yaml
# Benutzer
email: lena@…
role: pm                               # pm | dev (Pilot: global)
language: de                           # de | en
notifications: { clarify: true, test: true, approvals: false }
jiraToken: <verschlüsselt>
```

## 9. Entscheidungen und Regeln

### 9.1 PM-Funktionen und Claude
Ticket-Assistent, Ticket schärfen, Flow Desk und die Klärung mit dem PO laufen in Phase 1 **mit dem Abo des
Entwicklers, der sie benutzt**, auf seinem Worker (Entwickler übernehmen die PO-Rolle). Folge: Wer diese Funktionen
nutzt, braucht einen eigenen Worker online. Vor dem Start mit echten POs wird neu entschieden (Firmenzugang über
API/Bedrock oder eigene Plätze im Team-Plan).

### 9.2 Server und Worker
- **Worker holen sich Aufträge** (Pull, nur ausgehende Verbindungen, funktioniert hinter NAT): Long-Poll oder
  WebSocket zum Server, Auftrag per Lease übernehmen, Ereignisse (Stage, Tool-Ergebnisse, Freigaben, Usage) melden.
- **Agenten-Daten werden auf den Server repliziert:** Der Worker führt jeden Agenten auf seiner lokalen
  pi-durable-DB aus (das bleibt der schreibende Speicher: jeder Schritt ist eine lokale, atomare Transaktion und läuft
  auch ohne Netz weiter). Jede abgeschlossene Transaktion (Commit mit fortlaufender Nummer) schickt er sofort an den
  Server; nach einer Unterbrechung holt er ab der letzten bestätigten Nummer nach. Der Server hält damit eine
  vollständige, nahezu aktuelle Kopie: Transkripte, Tasks, Dokumente, Usage. Clients lesen alles vom Server, auch wenn
  der Worker offline ist. Technisch: `subscribeCommits` der Harness bzw. eine replizierende `Storage`-Hülle.
- **Warum keine gemeinsame DB:** Ein entfernter Speicher hieße einen Netzwerk-Roundtrip pro Agenten-Schritt; bei
  Netzaussetzern (Laptop) bliebe der Agent stehen – genau das soll Durable Pi verhindern.
- **Flow-Zustand:** Die Server-DB ist die Wahrheit für Ticket, Stage, Lauf, Worker, Reviews und Freigaben.
- **Ticket-Tools auf dem Worker:** `submit_fix`, `open_mr` nutzen git/glab des Workers; `update_ticket` usw. melden
  den Stage-Wechsel an den Server; Jira-Kommentare und Status-Übergänge schreibt der Server.
- **Ausfall:** Fällt ein Worker aus, zeigt das Ticket „pausiert“. Kommt er zurück, setzt Durable Pi exakt dort fort
  und gleicht ab.
- **Worker endgültig weg:** Ein Entwickler kann den Lauf einem anderen Worker geben. Der bekommt die Replik vom
  Server (in eine frische lokale DB eingespielt) und den Branch aus GitLab – deshalb pusht `submit_fix` den Branch
  (ohne MR). Was nach dem letzten Push im Worktree geändert wurde, ist verloren; der Agent bekommt beim Fortsetzen den
  Hinweis „Worktree auf Commit <sha> wiederhergestellt, spätere Änderungen fehlen – prüfe git status und mach sie
  neu“.

### 9.3 Nie zwei Agenten an einem Ticket
- Start ist eine **atomare Übernahme in der Server-DB**: ein Lauf je Ticket (eindeutige Bedingung), angelegt in
  einer Transaktion; ein zweiter Start, ein Doppelklick oder ein zweiter Client bekommt den bestehenden Lauf zurück.
  Jeder Start trägt eine Idempotenz-ID.
- Worker übernehmen Aufträge nur per **Lease mit Heartbeat**. Läuft die Lease ab, wird der Auftrag **nicht**
  automatisch neu vergeben; das Ticket wird „pausiert“, ein Entwickler entscheidet.
- **Fencing:** Jede Lease trägt eine fortlaufende Epoche. Gibt ein Entwickler den Lauf einem anderen Worker, steigt
  die Epoche; der Server lehnt danach Commits und Ereignisse mit alter Epoche ab, und ein zurückkehrender alter
  Worker stoppt seinen Agenten, statt weiterzuarbeiten.
- Jede Änderung geht sofort über den Realtime-Stream an alle verbundenen Clients.

### 9.4 Jira
- **Zugang:** im Pilot ein persönlicher API-Token je Projekt (beim Anlegen hinterlegt), verschlüsselt gespeichert.
  Später ein Service-Account. Alles, was mit diesem Token geschrieben wird, nennt im Text, wer es ausgelöst hat.
- **Schreib-Defaults:** REST v3 vom Server. Priorität über `fields.priority`; Rangfolge über die Agile-API
  (`/rest/agile/1.0/issue/rank`, vor bzw. nach dem Nachbarn); Freigabe = Label hinzufügen/entfernen; Beschreibung
  im ADF-Format, beim Schärfen wird ein Abschnitt „Akzeptanzkriterien“ angehängt bzw. ersetzt, der übrige Text
  bleibt; Anlegen mit Typ, Priorität, Zusammenfassung, Beschreibung, Labels (Komponenten, Epic und Vorlage je Projekt
  später); Kommentare in ADF.
- **Status-Übergänge:** Weil das Board die Spalten aus Jira übernimmt, setzt der Server den Jira-Status bei Start,
  MR, Testen und Erledigt nach `statusMap` (Default: über `statusCategory` erkannt). Das sind Übergänge, keine
  Kommentare.
- **Board:** Spalten aus der Jira-Board-Konfiguration.
- **Zuweisung:** Ein Ticket mit laufendem Agenten ist in Jira immer der Person zugewiesen, deren Agent es bearbeitet:
  dem Besitzer des Workers, bei einem Server-Worker der Person, die den Agenten gestartet hat. Der Server setzt das
  beim Start (Jira braucht dafür die `accountId` der Person, einmal pro Benutzer über die E-Mail ermittelt; der
  Token braucht das Recht „Assign Issues“). Nach dem Erledigen bleibt die Zuweisung.

### 9.5 Änderungen in Jira, während ein Agent läuft
Der Poller vergleicht jedes laufende Ticket mit dem letzten Stand:

| Änderung in Jira | Reaktion |
|---|---|
| Freigabe-Label entfernt | Agent pausiert nach dem aktuellen Schritt; Karte „Freigabe entzogen – fortsetzen oder abbrechen?“ |
| Ticket auf Done oder geschlossen | Lauf wird abgebrochen, Ticket „in Jira erledigt“; Branch bleibt, Worktree wird nach 7 Tagen aufgeräumt |
| Beschreibung oder Akzeptanzkriterien geändert | Agent bekommt die Änderung als nächste Nachricht; liegt schon ein MR vor, wird das Ticket zur Nacharbeit markiert |
| Priorität oder Rang geändert | nur Reihenfolge in Warteschlange und Feed |
| Zuweisung an eine andere Person geändert | Agent pausiert; Karte „<Name> übernimmt?“ – bestätigen gibt den Lauf an einen Worker dieser Person (oder beendet ihn), ablehnen stellt die Zuweisung in Jira wieder her |
| Zuweisung entfernt | Server stellt sie wieder her (laufender Agent = zugewiesene Person) |
| Kommentar | ignoriert (der Kanal ist die Session); Ausnahme `/approve` bei Auto-Merge |

### 9.6 Kev
Kev läuft auf dem Host, nicht im Container: Docker und Podman starten auf dem Mac eine Linux-VM. Die hat keinen
Zugriff auf Metal/MLX, worauf Kev auf Apple Silicon läuft (Podman bietet experimentell nur eine Vulkan-GPU an, die Kev
nicht nutzt); Kev fiele auf die CPU zurück und wäre um ein Vielfaches langsamer. Der Container erreicht
Kev über `host.containers.internal` (Podman) bzw. `host.docker.internal` (Docker). Auf einem späteren Linux-Server
braucht Kev eine GPU (CUDA) oder läuft auf einem Mac im Netz.

### 9.7 Dispatch
- Je Projekt `manual` (Default) oder `auto`; je Worker „nimmt automatisch verteilte Tickets an“ ja/nein.
  Automatisch gestartet wird nur, wenn beides zutrifft.
- Reihenfolge: Priorität, bei Gleichstand Jira-Rangfolge, dann Alter.
- Kapazität: Slots je Worker. Ein Ticket in der Klärung belegt keinen Slot.
- Automatisch nur Tickets, die Kev als startklar einstuft (oder die geschärft sind).

## 10. Offen

**Bestätigt nach Nachfrage:** Jira-Status-Übergänge (9.4) · Projekt-Verwaltung für alle, Agent-Werkzeuge nur
Entwickler (4) · persönlicher Jira-Token für Phase 1, Service-Account vor dem Teamstart · Priorität, bei Gleichstand
Rangfolge (9.7) · Lane nur vor dem Start · Flow-Tools nicht abschaltbar · Agenten-Daten auf den Server replizieren
(9.2).

**Noch zu bestätigen:** `submit_fix` pusht den Branch (ohne MR), damit ein Lauf einen endgültigen Worker-Verlust
übersteht (9.2). Heute pusht erst `open_mr`.

**Während Phase 0/1:** Mitteilungen im Detail (Kanäle, wer bekommt was) · mehrere Repos je Projekt in der UI ·
Report-Details (Status → Band, Zeitraum, Caching, Jira-Rate-Limits) · Verhalten, wenn GitLab oder Jira nicht
erreichbar sind.

**Später:** Funktionsumfang auf dem Handy und PWA · SSO · Server-Worker im Betrieb · Anbindung der
Shop-/Incident-Demo · Auto-Merge im Dashboard (Freigabe-Karte), solange es aus ist, nicht sichtbar.
