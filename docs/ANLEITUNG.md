# Anleitung: Arbeiten mit Durable Pi auf deinem Claude-Abo

Diese Anleitung erklärt, was die Teile des Setups sind, wie du es startest, und wie du in typischen Situationen damit
arbeitest: Code verstehen, Bugs fixen, Features bauen, Merge Requests prüfen, Incidents untersuchen.

---

## 1. Auf einen Blick

| Teil | Wofür | Adresse |
|---|---|---|
| **Durable-Pi-Oberfläche** | Hier arbeitest du: Sessions, Agents, Chat, Freigaben | http://127.0.0.1:4781 |
| **Backend** (`dpi-backend`) | führt die Agents aus und speichert alles durable in SQLite | :4780 (nur intern) |
| **Claude Code** | liefert die Antworten der Agents, über dein Claude-Abo | – |
| **Kev** | kleines lokales Entscheidungsmodell: bewertet Shell-Befehle („Damage control“) und Logzeilen (Demo) | :8009 (nur intern) |
| **Proactive-Demo** | Vorführung „Agent findet und fixt einen Produktionsfehler von selbst“, mit erfundenem Shop und erfundenen Logs | http://localhost:4790 |

**Durable** heißt: Jeder Schritt eines Agents wird gespeichert, bevor er sichtbar wird. Du kannst den Browser
schließen, den Rechner neu starten oder das Backend abstürzen lassen. Der Agent macht dort weiter, wo er war. Offene
Freigaben bleiben offen, und kein Befehl läuft doppelt.

---

## 2. Starten und stoppen

```bash
duracel          # startet Kev, Backend und Oberfläche; zeigt die Logs; Ctrl+C stoppt alles
duracel -d       # dasselbe im Hintergrund
duracel status   # was läuft
duracel stop     # alles stoppen
```

Es ist **egal, in welchem Ordner** du `duracel` startest. Den Projektordner wählst du in der Oberfläche, pro Session.

Nach einem Neustart des Rechners reicht `duracel -d`. Laufende Arbeit setzen die Agents danach selbst fort.

---

## 3. Grundbegriffe in der Oberfläche

```
Gerät (local)
└── Session  = ein Projektordner, z. B. contitrade-aem   ("Workspace" in der Kopfzeile)
    ├── Main        = der erste Agent der Session
    ├── Fork #24    = Abzweigung von Main an einer Nachricht
    └── Subagent    = von einem Agent oder Job gestartet
```

- **Session:** ein Ordner, eine Datenbank. Alle Agents einer Session arbeiten im selben Ordner.
- **Agent:** eine Unterhaltung mit eigenem Modell, eigenen Einstellungen und eigenem Verlauf.
- **Senden-Modus** unten links im Eingabefeld:
  - **Follow-up**: wird nach der aktuellen Antwort bearbeitet (Standard)
  - **Steer**: greift sofort ein, nach dem laufenden Tool-Aufruf („Halt, nimm lieber …“)
  - **Reject if busy**: wird nur angenommen, wenn der Agent gerade nichts tut
- **Interrupt:** bricht die aktuelle Arbeit ab.
- **Slash-Befehle** im Eingabefeld: `/model`, `/thinking`, `/fork`, `/new`, `/name`, `/compact`, `/reset`, `/tasks`, `/help`.

**Linke Spalte (Inspector):**

| Tab | Inhalt |
|---|---|
| **Session** | Modell (wähle eines mit **Abo**), Denktiefe, Kontext-Füllstand, Tokens und **API-Gegenwert** (bezahlt wird über dein Abo; dessen Limits gelten) |
| **State** | gemeinsamer Notizblock (JSON) aller Agents, z. B. für Übergaben zwischen Agents |
| **Tasks** | alle laufenden durable Tasks, inklusive Jobs |
| **Tools** | welche Werkzeuge der Agent hat; Schalter **Read only** nimmt ihm alle schreibenden |
| **Extend** | Erweiterungen pro Agent: **Approvals**, **Project context**, **Damage control** (Kev), System prompts |

---

## 4. Eine Session anlegen

1. **New session** (oben rechts).
2. **Ordner** wählen, z. B. `~/Develop/conti/contitrade-aem`.
3. **Modell:**
   - **Claude Sonnet 5.5 · Abo** für fast alles
   - **Opus 5.5 · Abo** für schwierige Analysen und große Refactorings
   - **Haiku 4.5 · Abo** für schnelle, einfache Fragen
4. **Thinking** im Session-Tab: `low` für einfache Fragen, `medium` oder `high` für Bugs und Features.

Der Agent kennt sofort die `CLAUDE.md` und `AGENTS.md` deines Projekts (Erweiterung **Project context**). Im
Extend-Tab siehst du, welche Dateien er gelesen hat.

### Sessions aufräumen

Fahr mit der Maus über eine Session im Baum links. Rechts erscheinen drei Knöpfe:

| Knopf | Funktion |
|---|---|
| **+** | neuer Agent in dieser Session |
| Stift | Session umbenennen, z. B. „VAU-3197 Burger-Menü“ statt „New session“ |
| **Archiv-Kasten** | Session **archivieren**: stoppt ihre Arbeit und nimmt sie aus dem Baum |

Archivieren löscht nichts. Die Dateien wandern nach `~/.dpi/backend/archive/`. Endgültig löschen:
`rm -rf ~/.dpi/backend/archive/*`.

Einzelne Agents (Forks, Subagents) lassen sich nur umbenennen (Stift beim Agent), nicht entfernen. Tipp: eine Session
pro Aufgabe oder Ticket, und nach Abschluss archivieren. So bleibt der Baum übersichtlich.

---

## 5. Freigaben: was der Agent ohne dich darf

Die Erweiterung **Approvals** ist an. Alles, was etwas verändert, wartet auf dich, und zwar **direkt am Tool-Aufruf
im Chat**:

- **Allow once**: nur dieses eine Mal.
- **Always allow**: speichert eine Regel für die ganze Session.
- **Deny**: optional mit Notiz an den Agent („nimm lieber `npm run test:unit`“).

Ein gelbes Banner über dem Eingabefeld zeigt offene Freigaben, auch die von anderen Agents der Session. Im Baum steht
🔐 mit der Anzahl.

**Ohne Rückfrage erlaubt sind standardmäßig:**
- `edit` und `write`, also Dateien ändern, wie `acceptEdits` in Claude Code
- lesende Befehle von `jira`, `glab`, `gh` und `git` (`git status/log/diff`, `jira issue view`, `glab mr diff` …)

**Empfehlungen für `contitrade-aem`** (Extend → Approvals → Regel hinzufügen):

| Regel | Wirkung |
|---|---|
| `Bash(mvn -q test:*)`, `Bash(mvn test:*)` | Tests ohne Rückfrage |
| `Bash(npm run test:*)`, `Bash(npm run lint:*)` | Frontend-Tests und Linter |
| `edit` / `write` **entfernen** | wenn du jede Dateiänderung einzeln sehen willst |

Verkettete Befehle (`&&`, `;`, `|`, `>`) fallen nie unter eine Präfix-Regel. `git status && rm -rf x` fragt also
immer nach.

**Damage control (Kev)** ist eine zweite Sicherheitsstufe und standardmäßig **aus**. Eingeschaltet im Extend-Tab lässt
der Agent jeden Shell-Befehl von Kev bewerten und blockiert unumkehrbare (`rm -rf`, `git push --force`,
`reset --hard` …), **auch wenn du ihn freigegeben hast**. Sinnvoll bei Aufräumarbeiten oder wenn du Freigaben großzügig
erteilst.

---

## 6. Szenarien

### 6.1 Codebase verstehen (Onboarding, Analyse)

> „Gib mir einen Überblick über die Architektur: Module, Build, wo liegt das Frontend, wie hängen Komponenten und
> AEM-Templates zusammen? Ändere nichts.“

- Schalte im Tools-Tab **Read only** ein. Dann *kann* der Agent nichts ändern.
- Für Rückfragen zu einem Teilbereich: **Fork** an der Übersicht, damit der Hauptverlauf schlank bleibt.
- Ergebnisse, die andere Agents brauchen, lässt du im **State** ablegen: „Speichere die Modulliste in App State unter
  /architecture.“

### 6.2 Bug fixen nach Jira-Ticket

> „fix https://diva-e.atlassian.net/browse/VAU-3197. Zeig mir zuerst deinen Plan und warte auf mein OK.“

So läuft es ab:
1. Der Agent holt das Ticket selbst (`jira issue view … --comments 30`), ohne Rückfrage.
2. Er sucht die Ursache im Code, schlägt einen Plan vor und **wartet**, weil du darum gebeten hast.
3. Nach deinem „ok“ ändert er die Dateien und führt Tests aus. Für `mvn` und `npm` fragt er nach, außer du hast Regeln
   gesetzt.
4. Am Ende fasst er zusammen: was geändert wurde, welche Dateien, wie geprüft, was offen ist.

Tipps:
- **Thinking `medium` oder `high`**, **Sonnet** oder bei kniffligen Fällen **Opus**.
- Committen, pushen und Ticket-Status ändert er **nur auf ausdrücklichen Wunsch**. So steht es in seinen Anweisungen.
- Wenn er in die falsche Richtung läuft: **Steer** („Nicht im Template, das Problem ist im CSS des Burger-Menüs“).

### 6.3 Feature entwickeln

> „Neues Feature laut VAU-1234. Plane zuerst: betroffene Komponenten, Dialogfelder, Tests. Warte auf mein OK.“

- **Erst planen lassen**, den Plan im Chat besprechen, dann „Setz Schritt 1 um“. Kleine Schritte sind leichter zu
  prüfen.
- Für **Alternativen**: an der Plan-Nachricht forken (Fork-Knopf an der Antwort) und im Fork einen anderen Ansatz
  ausprobieren. Beide Agents arbeiten im **selben Ordner**, also nicht beide gleichzeitig Dateien ändern lassen.
  Ideal ist ein Fork mit **Read only** zum Vergleichen.
- Für **parallele Teilaufgaben**: `/new` legt einen weiteren Agent an, z. B. einen für Tests, während Main das Feature
  baut.
- Lange Arbeit läuft weiter, auch wenn du den Browser schließt.

### 6.4 Merge Request reviewen

> „Reviewe MR !3305 in conti/contitrade-aem: Verständlichkeit, Fehler, fehlende Tests. Schreib keine Kommentare in
> GitLab.“

- Der Agent liest mit `glab mr view` und `glab mr diff`, ohne Rückfrage.
- Am besten **Read only** einschalten.
- Kommentare in GitLab schreibt er nur, wenn du es ausdrücklich verlangst, und dann mit Freigabe.

### 6.5 Incident untersuchen

**Heute (manuell):** Du gibst dem Agent die Spur, also eine Fehlermeldung, Logauszüge, eine Ticket-Nummer oder eine
Pipeline.

> „In Prod schlägt der Checkout fehl, hier der Stacktrace: … Finde die Ursache, schlag einen Fix vor. Nichts deployen.“

> „Die Pipeline auf develop ist rot. Schau dir mit `glab ci status` und `glab ci list` an, woran es liegt.“

**Die Proactive-Demo** zeigt das Ziel: Ein Watcher liest Logs, Kev bewertet jede Zeile, bei gehäuften Fehlern startet
**von selbst** ein Agent, fixt den Fehler und wartet auf deine Deploy-Freigabe. Sie läuft aber nur mit dem erfundenen
Shop und erfundenen Logs, nicht mit `contitrade-aem`. Siehe Abschnitt 7.

### 6.6 Aufräumen und größere Umbauten

> „Entferne die alten v1-Checkout-Komponenten, die nicht mehr referenziert werden.“

- **Damage control (Kev)** einschalten. Dann blockiert Kev unumkehrbare Befehle auch nach deiner Freigabe.
- Vorher einen sauberen Git-Stand haben. Der Agent prüft mit `git status` und `git diff`.

### 6.7 Mehrere Dinge gleichzeitig

- Eine **Session pro Projekt**, mehrere **Agents pro Session** für unabhängige Fragen.
- Offene Freigaben anderer Agents zeigt das Banner. **Open** springt hin.
- Mit **Steer** lenkst du um, ohne neu anzufangen. Mit **Interrupt** brichst du ab.

---

## 7. Die Proactive-Demo (Incident-Ansicht)

```bash
duracel -d                      # Kev muss laufen
just proactive take             # frisch zurücksetzen und starten → http://localhost:4790
just proactive start            # weitermachen, ohne zurückzusetzen
just proactive take --tts off   # ohne Sprachansage
```

Ablauf: T+5 s geht ein fehlerhafter Deploy live, ~T+11 s öffnet sich **INC-0001** von selbst, ~T+34 s wartet der
Fix auf deine **Deploy-Freigabe** (mit Sprachansage). Alle Fehlerzeilen mit gleichem Fingerabdruck (Service, Route,
Fehlertyp) gehören zu **einem** Incident. Sie sind Belege, kein eigener Auslöser.

**Einstellungen** (hinter `just proactive take`):

| Option | Standard | Bedeutung |
|---|---|---|
| `--model claude-opus-5-5` | `claude-sonnet-5-5` | Modell des Incident-Agents (Abo) |
| `--thinking medium` | `high` | Denktiefe |
| `--incident-threshold 3` | 3 | so viele „incident“-Urteile mit gleichem Fingerabdruck … |
| `--suspicious-threshold 8` | 8 | … oder so viele „suspicious“ … |
| `--window 120` | 120 s | … innerhalb dieses Zeitfensters öffnen einen Incident |
| `--rate 1.2` | 1,2/s (mit lokalem Kev) | Logzeilen pro Sekunde |
| `--jev-concurrency 2` | 2 | parallele Anfragen an Kev |
| `--tts host\|browser\|both\|off` | `host` | Sprachansage über den Mac, im Browser, beides, aus |
| `--announce-open` | aus | zusätzlich eine Ansage, wenn ein Incident aufgeht |
| `--bug-at 5` | 5 s | wann der Fehler live geht (`just proactive bug` sofort) |

Tiefer anpassen, im Code unter `apps/proactive-dpi-demo/apps/proactive-dpi-be/src/`:
- `watcher.ts`: die Fragen an Kev („normal / suspicious / incident“, Schweregrad) und der Fingerabdruck
- `extensions.ts`: das Playbook des Incident-Agents (Abschnitt `incident_playbook`) und seine Werkzeuge (`deploy` …)
- Sprachansage: `DPI_READY_SPEECH`, `DPI_OPENED_SPEECH`, Stimme `DPI_SAY_VOICE`

**Für echtes Incident-Tracking von `contitrade-aem` fehlen drei Dinge:**
1. eine **echte Log-Quelle**, z. B. AEM-Cloud-Logs oder ein Log-Export, die in die Log-Tabelle der Demo schreibt
2. **Fragen und Fingerabdruck** passend zu AEM-Logs
3. ein **Playbook für AEM**: Repo, Build, Tests. Der „Deploy“ wäre eher ein MR als ein Rollout.

Das ist ein eigenes kleines Projekt. Die durable Teile (Erkennung, Agent, Freigabe) gibt es schon.

---

## 8. Eigene Anweisungen für alle Agents

- **Pro Projekt:** `CLAUDE.md` oder `AGENTS.md` im Projekt. Der Agent liest sie automatisch, inklusive `@`-Importe.
- **Für alle Projekte auf diesem Rechner:** `~/.dpi/instructions.md`, z. B. „Antworte auf Deutsch“ oder „Branches
  heißen feature/VAU-1234-…“.
- **Pro Agent:** System prompts im Extend-Tab.

Änderungen gelten ab der nächsten Nachricht.

---

## 9. Kosten und Limits

- Alles läuft über **dein Claude-Abo**. Die Dollarbeträge in der Oberfläche sind nur **API-Gegenwert** zum
  Vergleich.
- Es gelten die **Nutzungslimits deines Abos**, geteilt mit Claude Code und claude.ai.
- Spartipps: Haiku für Kleinkram, `/compact` bei langen Verläufen, `/reset` für einen frischen Kontext (der Verlauf
  bleibt gespeichert).

---

## 10. Wenn etwas hakt

| Problem | Lösung |
|---|---|
| Agent tut nichts, Status „Waiting for you“ | Er wartet auf eine Freigabe: gelbes Banner → **Show** / **Open** |
| „Claude Code would bill via …“ | `claude auth login` ausführen, `ANTHROPIC_API_KEY` nicht setzen |
| Oberfläche nicht erreichbar | `duracel status`, dann `duracel -d` |
| Kev nicht erreichbar | `duracel -d` startet ihn; Log: `~/.dpi/logs/kev.log` |
| Demo startet nicht: „local judge does not answer“ | zuerst `duracel -d` |
| Agent hängt oder läuft in die falsche Richtung | **Steer**, notfalls **Interrupt** |
| Etwas Unerwartetes im Backend | `~/.dpi/logs/backend.log`; ausführlich mit `DPI_CLAUDE_DEBUG=1` |

Logs liegen in `~/.dpi/logs/`, Daten in `~/.dpi/backend/`. Archivierte Sessions werden nur verschoben, nach
`~/.dpi/backend/archive/`.
