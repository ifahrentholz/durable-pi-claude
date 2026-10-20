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
   Mensch im Dashboard am Ticket ändert, geht direkt nach Jira. Der Flow speichert nur Agent- und Flow-Zustand.
2. **Jira bekommt genau einen Kommentar pro Ticket:** beim Öffnen des MR, ein Satz zum Fix plus Link. Risiken stehen
   im MR. Ticket-Beschreibung und Akzeptanzkriterien ändert nur ein Mensch ausdrücklich („Ticket schärfen“).
3. **Rechte prüft der Server**, nicht die UI. Ein PM kann auch über API oder Terminal keine Agenten steuern.
4. **Ein Ticket bleibt auf seinem Worker**: dort liegen Session und Worktree.
5. **Claude-Zugangsdaten verlassen den Worker nicht.** Jeder Worker läuft mit dem Abo seines Besitzers; der
   Flow-Server speichert keine Claude-Credentials (Nutzungsbedingungen: gewöhnliche, individuelle Nutzung, keine
   Weiterleitung fremder Anfragen über Pro/Max).
6. **Eine Farbsprache**, überall gleich (siehe 6.2).

## 3. Architektur

```
Clients (Tauri · Browser · Handy · flow-tui) ── Login, Rolle ──▶ Flow-Server (Team-Instanz)
                                                                  ├─ Projekte, Benutzer, Rollen, Jira-Tokens
                                                                  ├─ je Projekt: Poller, Kev-Einordnung, Lanes, Dispatch
                                                                  ├─ Review-Policy, Reports (aus Jira-Changelog)
                                                                  └─ Realtime-Stream an die Clients
                                                                        │ v1-API (wie der Hub)
                                                                        ▼
                                                    Worker = dpi-backend auf Entwickler-Rechnern (später Server)
                                                      Ticket-Agenten, Reviewer, Worktrees, git/glab, Claude-Abo
Jira Cloud (diva-e.atlassian.net) · GitLab · Kev (Host, siehe 8.B5)
```

- **Pilot lokal:** Flow-Server als Container (Podman oder Docker Compose) auf dem Mac, verhält sich wie auf einer VM.
  Worker und Kev laufen auf dem Host. Später zieht der Container unverändert auf einen Server.
- **Clients:** Web-UI (responsiv, später PWA), Tauri-App (Mitteilungen, Dock-Badge, Menüleiste, optional lokalen
  Worker starten – wie `apps/dpi-desktop`), Terminal-Client analog `dpi-tui`.
- **Login:** Einladungs-Accounts im Pilot, SSO (GitLab-OAuth) später.
- **Jira:** persönlicher API-Token je Benutzer für alles, was ein Mensch auslöst.

## 4. Rollen

| | PM / PO | Entwickler |
|---|---|---|
| Projekte sehen, anlegen (ein Jira-Projekt nur einmal) | ✓ | ✓ |
| Priorität, Rangfolge, Freigabe, Tickets anlegen und schärfen | ✓ | ✓ |
| Klärung (Grill) beantworten, Scope bestätigen | ✓ | (sieht sie) |
| Testen, Findings melden | ✓ | ✓ |
| Reports | ✓ | ✓ |
| Agenten: Chat, Start, Modell, Permissions, Session/State/Tasks/Tools/Extend | – | ✓ |
| Repo, Tests, Agent-Einstellungen eines Projekts ändern | – | ✓ |
| Worker verbinden | – | ✓ |

Worker sieht ein PM nur als Hinweis „pausiert – Rechner offline“.

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
| PM/PO | neue, noch nicht angesehene oder freigegebene Tickets · Klärungen · Bereit zum Testen |
| Entwickler | neue Tickets · Bereit zum Testen · MR wartet auf Code-Review · Hilfe nötig (blockiert) · pausiert |

„▸n“ daneben: aktiv arbeitende Agenten. Keine Projekt-Tags.

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
implement → review → MR. Nach dem MR im Dashboard zusätzlich: Testen → Erledigt (siehe 8.B4).

## 7. Funktionen

### 7.1 Projekte
- Anlegen: Jira-Projekt-Key (Duplikatprüfung), Name, GitLab-Repo, Ziel-Branch, Branch-Schema, Mitglieder.
- Einstellungen: Name, Label für „freigegeben“, Mitglieder und Rollen; nur Entwickler: Repo, Branch, Schema,
  Test-Befehl, Standard-Permissions, Reviewer-Modell und Review-Versuche.
- Projektübersicht: Offen, In Arbeit, Braucht dich, Erledigt, Fortschritt, Projektpunkt.

### 7.2 Feed
- Stat-Leiste: ready · needs clar. · in progress · waiting you · done · blocked.
- Angeheftet: alle gestarteten, nicht erledigten Tickets mit Status.
- Tabelle: gefunden um · Priorität (Klick ändert sie in Jira) · Ticket (NEU-Marke) · Kev/Status · Freigabe-Schalter
  (setzt das Jira-Label). Ziehen ändert die Rangfolge in Jira.
- Polling: neue Tickets gleiten ein, der Kev-Chip pulsiert, bis Kev entschieden hat.

### 7.3 Ticket schärfen (vor dem Start)
Für Tickets, die Kev als zu vage einstuft. Ein Assistent **ohne Code-Zugriff** fragt nach (eine Frage, Empfehlung,
Alternative, freie Antwort), Kev bewertet live neu. „In Jira aktualisieren“ schreibt Beschreibung und
Akzeptanzkriterien (Bearbeiten, kein Kommentar). Ein so geschärftes Feature startet ohne zweite Klärung.

### 7.4 Klärung (Grill im Agenten)
Für Features und vage Tickets, die ungeschärft gestartet wurden. Der Agent fragt den PO in der Session, eine Frage
nach der anderen mit Empfehlung; „Scope bestätigen“ beendet die Klärung (`confirm_scope`). Kein Slot belegt.

### 7.5 Ticket-Assistent
Beschreibung in eigenen Worten → Rückfragen → Entwurf mit Akzeptanzkriterien und Kev-Bewertung → „In Jira anlegen“,
optional gleich freigeben.

### 7.6 Testen und Findings
Ticket gemerged und auf der Dev-Stage: „Funktioniert“ setzt es in Jira auf Done. „Finding melden“ (Schritte,
erwartet, tatsächlich, Screenshot) gibt es an den bisherigen Agenten (sonst einen neuen); er arbeitet nach und
öffnet einen neuen MR.

### 7.7 Reports (Kanban)
Fortschritt, Durchsatz je Woche, Durchlaufzeit (Median), Anteil der Agenten, Cumulative Flow, Burnup – berechnet aus
der Jira-Historie über die offizielle REST-API (die Chart-Endpunkte `greenhopper/rapid/charts` sind intern und nicht
unterstützt).

### 7.8 Agent-Werkzeuge (Entwickler)
- Chat mit Main (Follow-up/Steer, Interrupt), Review #n nur lesend; Ticket-Brief, Thinking, Tool-Karten live.
- Modell-Wähler am Chat-Chip und im Session-Tab: Kev-Empfehlung, kein Modell unter Sonnet für Code-Agenten,
  Reviewer fest auf Opus; gilt ab dem nächsten Schritt.
- Session: Modell, Thinking, Permissions Ask/Auto/YOLO, Auto-Compaction-Schwelle, Stats.
- State (App State des Tickets), Tasks (durable Tasks, abbrechen), Tools (an/aus, Read-only), Extend (Extensions).
- Start mit Worker-Wahl (offline Worker gesperrt).

### 7.9 Worker
Verbinden wie im Durable-Pi-Netz: dieser Rechner · Team-Rechner (SSH) · Server/VM · laufendes dpi-backend (URL);
Slots, Projekte, Befehl. Offline-Worker pausiert seine Tickets. Kein Umzug laufender Tickets im Pilot.

---

## 8. Offene Punkte

### Muss vor dem Bau entschieden werden

**B1 · Mit wessen Claude-Zugang laufen die PM-Funktionen?** Ticket-Assistent, Ticket schärfen, Flow Desk und die
Klärung mit dem PO sind Modell-Aufrufe für einen PM. Über das Abo eines Entwicklers wäre das nicht seine eigene,
individuelle Nutzung; der Flow-Server darf keine Abo-Zugangsdaten halten.
*Optionen:* Firmenzugang (API-Key/Bedrock, kommerzielle Bedingungen) nur für diese Funktionen · Team-Plan-Plätze für
POs, Funktionen laufen auf einem Worker des PO · im Pilot nur du als Nutzer, Entscheidung vor dem Teamstart.

**B2 · Wie steuert der Flow-Server Agenten auf Workern?** Heute läuft der Jira Flow mit eigener Harness in
`jira-flow-be`. Zielbild: Agenten in `dpi-backend` auf Workern. Offen sind: Registrierung und Erreichbarkeit
(Server ruft Worker per v1-API wie der Hub, oder Worker holen Aufträge ab – wichtig, wenn Worker hinter NAT sind),
wo die Ticket-Tools laufen (`update_ticket`, `submit_fix`, `open_mr` brauchen Jira/GitLab: auf dem Worker mit dessen
glab, Rückmeldung an den Server), wie der Server Ticket-Zustand und Agent-Zustand zusammenführt, und was bei einem
Worker-Ausfall mitten im Review passiert.

**B3 · Startet „Freigeben“ den Agenten automatisch?** Das Mockup sagt teils „startet, sobald ein Worker frei ist“,
teils startet ein Entwickler manuell. Zu klären: Dispatch automatisch oder manuell; Reihenfolge (Rangfolge oder
Priorität – eine Regel); Slots je Worker und/oder Obergrenze je Projekt; ob ein Worker-Besitzer automatischem
Dispatch zustimmen muss (läuft auf seinem Rechner und Abo).

**B4 · Was passiert nach dem MR?** Der Jira Flow endet heute bei „MR offen“. Für Testen und Erledigt braucht es:
Erkennen, dass der MR gemerged ist (GitLab), Erkennen, dass er auf der Dev-Stage deployt ist (GitLab
Environments/Deployments oder Jira-Status), eine Zuordnung Flow-Stage ↔ Jira-Status und -Übergänge je Projekt, und
was „Erledigt“ heißt (gemerged, getestet, Jira Done).

**B5 · Wo läuft Kev, und mit wessen Jira-Zugang pollt der Server?** Kev nutzt auf dem Mac MLX (Apple Silicon) und
läuft nicht schnell in einem Linux-Container. Vorschlag: Kev auf dem Host, der Container erreicht ihn über
`host.containers.internal`/`host.docker.internal`; auf einem späteren Server braucht Kev eine GPU oder läuft auf
einem Mac im Netz. Der Poller liest Jira ohne Benutzer im Raum: Service-Account oder Token des Projektanlegers?

**B6 · Freigaben im Ask- und Auto-Modus.** Das Mockup bietet Permissions an, zeigt aber keine wartenden Tool-Aufrufe.
Zu spezifizieren: Freigabe-Karte im Agent-Chat und Zähler (wie `ApprovalCard` im Hub), nur Entwickler entscheiden,
Mitteilung an wen. Und: YOLO darf den Read-only-Schutz des Reviewers und den Flow-Guard nicht aufheben.

**B7 · Rollenmodell.** Rolle global oder je Projekt (Mitgliedschaft mit Rolle)? Wer ändert Mitglieder und
Einstellungen, wer löscht oder archiviert ein Projekt? Darf ein PM die Agent-Transkripte lesen?

### Während Phase 0/1 entscheiden

- **Finding nach dem Merge:** neuer Branch (Name?), Agent bekommt Screenshot als Bild, neue MR verlinkt das Finding,
  derselbe oder ein neuer Agent, wenn der alte archiviert ist.
- **Jira-Schreibzugriffe im Detail:** Rangfolge über die Agile-API, Priorität, Label, Beschreibung im ADF-Format,
  Felder beim Anlegen (Typ, Komponenten, Epic, Vorlage je Projekt).
- **Board-Spalten:** aus der Jira-Board-Konfiguration übernehmen oder feste Flow-Spalten?
- **Lane ändern:** wer (nur Entwickler?) und wo (vor dem Start in der Ticket-Ansicht).
- **Änderungen in Jira während ein Agent läuft:** Label entfernt, Ticket geschlossen, Beschreibung geändert –
  Agent stoppen, informieren oder ignorieren; Aufräumen von Worktree und Branch.
- **Kev bleibt beim Schärfen „zu vage“:** Grenze der Runden, manuelles „trotzdem bereit“?
- **Gesperrte Flow-Tools:** `open_mr`, `submit_fix` usw. dürfen im Tools-Tab nicht abschaltbar sein.
- **Projekt-Konfiguration:** Schema (alle heutigen Felder aus `jira-flow.config.json` plus Mitglieder, Default-
  Permissions, Compaction-Schwelle), mehrere Repos je Projekt, Migration der heutigen Datei.
- **Benutzerbezogener Zustand:** „NEU“ und „angesehen“ je Benutzer; Mitteilungen (wer bekommt was: PO bei Klärung
  und Testen, Entwickler bei Risiko, Blocker, Worker offline) in Tauri, Browser, später Handy.
- **Mehrere Benutzer gleichzeitig:** Realtime-Stream, zwei POs beantworten dieselbe Klärung, Konflikte.
- **Feed bei vielen Tickets:** Filter (Lane, Status, Priorität), Suche, erledigte ausblenden – fehlt im Mockup.
- **Sprache der Oberfläche:** Das Mockup mischt Deutsch mit englischen Stat-Begriffen (ready, waiting you).

### Später

Reports im Detail (welcher Jira-Status zu welchem Band, Zeitraum, Caching und Jira-Rate-Limits) · Funktionsumfang auf
dem Handy und PWA · SSO · Server-Worker im Betrieb · Kosten-Anzeige (Abo, „API-Äquivalent“) und ob PMs sie sehen ·
Anbindung der Shop-/Incident-Demo · Auto-Merge im Dashboard (Freigabe-Karte), solange es aus ist, nicht sichtbar.
