# Flow Dashboard – Umsetzungsplan (Pilot)

Grundlage: `docs/flow-dashboard-spec.md` (was), `docs/flow-dashboard-design.md` (wie). Gearbeitet wird auf
`pilot/flow-dashboard`; nichts geht nach `main`.

**Arbeitsweise:** Jede Phase endet mit einer Abnahme gegen die Kriterien unten, vorgeführt am echten System
(lokaler Container, ein Worker auf deinem Mac, ein echtes Jira-Testprojekt). Innerhalb einer Phase kleine Commits
mit Tests; jede Phase hat einen Stand, der läuft. Größen sind grobe Schätzungen in Arbeitstagen für eine Person mit
Agent-Unterstützung und dienen der Reihenfolge, nicht als Zusage.

---

## Phase 0 – Fundament (≈ 8–12 Tage)

Ziel: Ein Ticket geht ohne Oberfläche, nur über die API, von „freigegeben“ bis zum MR – mit Server im Container,
Agent auf dem Worker, Replikation und den Garantien aus Spec 9.3.

1. **Spikes S1–S6** (Design 10). Ergebnis als kurze Notiz je Spike; scheitert einer, wird das Design angepasst, bevor
   gebaut wird. S1 (Replikation) zuerst – davon hängt am meisten ab.
2. **Repo-Gerüst:** `flow-core`, `flow-server`, `flow-worker`, `deploy/flow` (Containerfile, compose mit Volume),
   `just flow …`.
3. **flow-core:** Konfig-Schema v1 (zod) mit Defaults und Import der heutigen `jira-flow.config.json`; Lanes,
   Review-Policy, Shell-Guard aus `jira-flow-be` übernommen, Tests mit.
4. **flow-server:** DB + Migrationen, Einladung/Login/API-Tokens, Projekte (anlegen, Verbindung testen),
   verschlüsselte Geheimnisse, Jira-Adapter (lesen; schreiben über Outbox), Poller + Kev, Tickets-Tabelle,
   atomarer Start, Worker-API (hello, stream, claim, heartbeat, events, replicate, replica, judge), Lease-Ablauf →
   `paused`, Fencing, Outbox mit Backoff, Jira-Kommentar beim MR, Zuweisung beim Start.
5. **flow-worker im dpi-backend:** Verbindung, Angebote annehmen, Lauf = dpi-Session im Worktree, Ticket-Agent und
   Reviewer (aus `jira-flow-be`) auf Ereignisse umgestellt, `submit_fix` pusht, Replikation über die Speicher-Hülle,
   Wiederanlauf nach Neustart.
6. **Tests:** Integration mit Fake-Jira/-GitLab/-Kev; E2E mit Faux-Provider.

**Abnahme**
- `just flow up` startet den Server im Container; Kev läuft auf dem Host und wird erreicht.
- Ein Projekt wird aus der heutigen Config übernommen; der Poller findet ein gelabeltes Testticket, Kev ordnet es ein.
- `POST /tickets/:key/start` mit dem eigenen Worker: Agent implementiert, Review läuft, MR wird geöffnet, Jira
  bekommt genau den MR-Kommentar, das Ticket ist dem Worker-Besitzer zugewiesen.
- Zwei gleichzeitige Starts (zwei Clients, Doppelklick) ergeben **einen** Lauf.
- `kill -9` des Workers mitten im Lauf: Ticket „pausiert“; nach Neustart setzt der Agent fort, Transkript lückenlos.
- Übergabe an einen zweiten Worker: Fortsetzung aus der Replik; der alte Worker wird beim Wiederkommen gestoppt
  (`409 fenced`).
- Server-Neustart verliert nichts (Läufe, Outbox, Replik).

## Phase 1 – Oberfläche für Entwickler und Grundgerüst (≈ 10–14 Tage)

Ziel: Das Dashboard aus dem Mockup läuft gegen den echten Server; ein Entwickler steuert damit Tickets und Agenten.

- `flow-web`: Shell mit drei Spalten, Kopfzeile (Fokus, Polling-Ring, Kev, Worker), Baum (Fokus, alle Projekte,
  Netzwerk), Feed mit Stat-Leiste, angehefteten Tickets, Tabelle, **Filtern**, NEU je Benutzer, Freigabe, Priorität,
  Rang (Ziehen), Lane vor dem Start; Ticket-Karte mit Stepper, Jira-Inhalt, Kosten; Board mit Spalten aus Jira.
- Agent-Ansicht: Main/Review aus der Replik, Live-Generierung, Tool-Karten, Composer (Follow-up/Steer, Interrupt),
  **Freigabe-Karte**, Modell-Wähler, Inspector (Session mit Permissions und Kompaktierung, State, Tasks, Tools mit
  gesperrten Flow-Tools, Extend).
- Rollen (PM/Dev) durchgängig, serverseitig geprüft; i18n-Gerüst mit Deutsch und Englisch; Realtime-Stream.
- Worker verbinden (Join-Token, Befehl), Worker-Status, „pausiert“.
- In-App-Mitteilungen (Glocke).

**Abnahme**
- Alle Entwickler-Abläufe des Mockups funktionieren gegen echte Daten (Liste als Playwright-Tests).
- Zwei Browser gleichzeitig: Start, Freigabe, Priorität erscheinen im anderen Browser in unter 1 s; kein doppelter Lauf.
- Eine Tool-Freigabe im Auto-Modus hält den Agenten an, bis ein Entwickler entscheidet; als PM-Benutzer ist sie
  sichtbar, aber nicht entscheidbar; Permission-Modus ist für PMs gesperrt (auch per API: 403).
- Umschalten auf Englisch übersetzt die gesamte Oberfläche.

## Phase 2 – Abläufe für PM/PO (≈ 10–14 Tage)

Ziel: Der vollständige Ticket-Lebenszyklus aus Spec 7, bedienbar für PMs (in Phase 1 durch Entwickler in PO-Rolle).

- Ticket-Assistent (anlegen in Jira), **Ticket schärfen** (Kev live, Beschreibung + Akzeptanzkriterien in ADF),
  Klärung mit dem PO in der UI, **Flow Desk** (lesende Tools, Aktionen als Knöpfe).
- Nach dem MR: Watcher (Merge, Pipeline), Testen, **Erledigt** (Jira Done + Kommentar), Finding mit Screenshot →
  Nacharbeit auf neuem Branch, neuer MR.
- Jira-Status-Übergänge nach `statusMap`; Reports (CFD, Durchsatz, Durchlaufzeit, Burnup, Kosten) aus dem Changelog
  mit Cache.
- Erster Start (Onboarding), Profil, Fehlerzustände sichtbar, PM-Wortwahl („Einschätzung“, „Art“, „Änderung zur
  Prüfung“), Tastatur.

**Abnahme**
- Ein vages Ticket wird geschärft, Kev stuft es danach als startklar ein, die Kriterien stehen in Jira.
- Ein Feature durchläuft die Klärung mit dem PO und startet nach „Scope bestätigen“.
- MR gemerged + Pipeline grün → Ticket in „Testen“; „Erledigt“ setzt Jira auf Done mit Kommentar; ein Finding führt
  zu neuem Branch und neuem MR.
- Flow Desk beantwortet die Beispielfragen aus Spec 7.6 korrekt und führt Vorschläge nur nach Klick aus.
- Reports stimmen mit einer Stichprobe aus Jira überein.

## Phase 3 – Automatik und Robustheit (≈ 6–9 Tage)

- Automatischer Dispatch je Projekt und Worker, Reihenfolge Priorität/Rang/Alter, Slots, **WIP-Limit**.
- Abo-Limits erkennen, „limitiert bis“, Dispatch überspringt.
- Reaktionen auf Jira-Änderungen während eines Laufs (Spec 9.5), Übergabe-Karte bei geänderter Zuweisung.
- Aufbewahrung und Aufräumen (Worktrees, Replik-Log), Backups (Litestream oder Snapshot), Health, Logs, Metriken.

**Abnahme**
- Mit `auto` startet ein freigegebenes Ticket ohne Klick, sobald ein Slot frei ist; bei 3 offenen MRs pausiert der
  Dispatch und zeigt warum.
- Ein simuliertes Rate-Limit nimmt den Worker aus dem Dispatch und gibt ihn zur angegebenen Zeit frei.
- Label entfernen, Ticket schließen, Beschreibung ändern, Zuweisung ändern: jeweils die Reaktion aus Spec 9.5.
- Wiederherstellen aus dem Backup auf einem frischen Container.

## Phase 4 – Clients (≈ 6–10 Tage)

- **Tauri-App** als dünner Client: Server-Adresse und Anmeldung, Token im Schlüsselbund, native Mitteilungen
  (Klick öffnet das Ticket), Dock-Badge, Menüleiste, Deep-Links, optional lokaler Worker (Entwickler).
- Handy: responsive Feinschliff, PWA-Manifest.
- `flow-tui`: Status, „Braucht dich“, freigeben, testen, erledigen.

**Abnahme**
- Die App verbindet sich mit dem Container-Server, zeigt Mitteilungen und den Badge, öffnet Tickets per Deep-Link,
  startet und stoppt den lokalen Worker.
- Die wichtigsten PM-Abläufe gehen auf dem Handy.
- Das Terminal zeigt Status und erledigt ein Ticket.

## Phase 5 – Team-Start (nach den vertagten Entscheidungen)

Blockiert durch Spec 15: Hosting-Ort (Kundencode, GitLab-Erreichbarkeit) und App-Verteilung (Apple Developer ID,
Windows). Danach: Deployment auf den gewählten Server (TLS, Proxy, Backups), Service-Account für Jira, Signierung
und Notarisierung, Entscheidung zu den Claude-Zugängen echter POs (Spec 9.1), optional SSO.

---

## Reihenfolge und Abhängigkeiten

```
S1–S6 ─▶ Phase 0 ─▶ Phase 1 ─▶ Phase 2 ─▶ Phase 3 ─▶ Phase 4
                                  └─ Phase 4 (Tauri) kann ab Phase 1 parallel beginnen
Phase 5 wartet auf die Entscheidungen aus Spec 15
```

## Risiken für den Plan

| Risiko | Wirkung | Gegenmaßnahme |
|---|---|---|
| S1 zeigt, dass die Speicher-Hülle nicht sauber wiederherstellt | Übergabe nach Totalausfall fällt weg | Replik nur lesend für Transkripte; Übergabe = neuer Lauf auf gepushtem Branch mit Zusammenfassung |
| Jira-Rechte des persönlichen Tokens reichen nicht (Rang, Zuweisen, Transitions) | einzelne Funktionen fehlen | in S3 früh prüfen; sonst Service-Account vorziehen |
| Volumen der Replikation bei Live-Generierung | Last und Speicher | Bündeln, gzip; Live-Fortschritt seltener replizieren |
| Umbau von `jira-flow-be` in Worker-Extensions dauert länger | Phase 0 verzögert sich | zuerst nur die Ticket-Lane, Frage- und Feature-Lane in Phase 2 |
| Kev auf einem späteren Server ohne GPU zu langsam | betrifft erst Phase 5 | Messung in Phase 3, Kev-0.8B auf CPU als Option |
