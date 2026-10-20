# Jira-Flow — Architektur-Skizze (nur Konzept, keine Implementierung)

> **Überholt in mehreren Punkten.** Erste Skizze vor der Umsetzung. Inzwischen gilt u. a.: Jira bekommt nur einen
> Kommentar (beim MR), ein Mensch merged (Auto-Merge optional), unabhängiges Review mit Risiko-Policy. Ist-Stand:
> README von `apps/proactive-dpi-demo/apps/jira-flow-be`; Dashboard: `docs/flow-dashboard-spec.md`.

Ziel: Jira-Tickets mit einem Stichwort werden von einer Durable-Pi-Agentenflotte
abgearbeitet. Einstieg entweder per Chat-Ticket (Radar-Klassifikation) oder per
Jira-Polling. Review-/MR-Links und Status fließen zurück ins Ticket.

Die Skizze kombiniert zwei bereits existierende Muster:

- **`apps/proactive-dpi-demo`** — Polling-Watcher, Judge-Gate, Fingerprint-Dedup,
  pro Vorgang eine *ownerlose durable Conversation* in eigenem *git-Worktree*,
  erzwungene Stage-Timeline, **checkpointed Approval-Phase** die Neustarts
  überlebt.
- **`agents/radar`** (omnigent-radar) — Klassifikation in die billigste Lane,
  Modellwahl pro Worker, Step-Menü `implement → review → deliver`.

Kurzfassung: **Radar liefert die Stages/Lanes, die Demo liefert die Durability,
das Polling, die Worktrees und die Approval-Mechanik.** Der einzige wirklich neue
Code ist der Jira-/GitLab-Adapter.

---

## 1. Datei-für-Datei-Mapping

Neue App `apps/jira-flow-be` spiegelt `apps/proactive-dpi-demo/apps/proactive-dpi-be`:

| Demo-Datei | Rolle in der Demo | Jira-Flow-Entsprechung | Was ändert sich |
|---|---|---|---|
| `src/watcher.ts` | `setInterval(poll)` tailt Log-Store, Judge pro Zeile, Schwellwert → `Trigger` | `src/jira-poller.ts` | Quelle = Jira-JQL statt Log-Store; **Prio-Queue** statt FIFO; Judge-Gate pro Ticket |
| `src/jev.ts` | Judge (Jev/Kev) beurteilt Log-Zeilen | `src/judge.ts` | Wiederverwenden: beurteilt „lohnt sich Automatik? Beschreibung ausreichend?" |
| `src/ops.ts` | Harness, Root-Conversation, `openIncident`, Worktree, `kickoff`, `recover`, Concurrency | `src/orchestrator.ts` | gleiche Struktur; Brief = Radar-Lane-2-Chain; **Concurrency-Cap** |
| `src/extensions.ts` | Docs (`Incidents`/`Deploys`), Tools (`update_incident`/`submit_fix`/`deploy`), `DeployTask`-Phasen, `IncidentAgent` | `src/extensions.ts` | Docs = `Tickets`/`Merges`; Tools schreiben Jira-Status/Kommentar; `MergeTask` mit Approval-Phase gegen GitLab/Jira |
| `src/repo.ts` | `ensureWorktree`, `branchReview`, `verifyAndCommit` | `src/repo.ts` | fast unverändert; ein Worktree pro Ticket |
| `src/watch-store.ts` | SQLite: Logs + Verdicts | `src/jira-store.ts` | SQLite: gesehene Ticket-Keys + letzter Jira-Statusspiegel (Dedup über Neustart) |
| `src/config.ts` | provider/model/thresholds | `src/config.ts` | + `jql`, `pollIntervalMs`, `maxConcurrent`, `approvalMode` |
| `src/voice.ts` | optionale TTS-Ansage | — | optional |
| `apps/proactive-dpi-fe` | Vue-Dashboard | optional | Timeline-UI kann bleiben |

Durable-Pi-Primitive bleiben identisch zur Demo (`ops.ts`):

- `Harness.open(storage, { models, registry, env, settings }, ctx)` — eine Harness.
- `tx.createConversation({ ownership: { kind: "ownerless" } })` — pro Ticket.
- `configure(tx, cid, { model, extensions, cwd, instructions })`.
- `conversation.submit({ type, content, requestId }, ctx)` — `requestId`
  (`ticket:<KEY>:brief`) macht den Start **exactly-once** über Crashes hinweg.
- `recover()` beim Start: jedes offene Ticket bekommt Worktree + Brief genau einmal.

---

## 2. Die offenen Punkte, konkret beantwortet

### (1) Stichwort **und** Priorität — Wichtigste zuerst

Zwei Stufen:

- **Stichwort = Filter.** JQL erledigt das serverseitig, z. B.
  `labels = "ai-flow" AND status = "To Do" ORDER BY priority DESC, created ASC`.
- **Priorität = Scheduling.** Der Demo-Watcher nutzt heute eine **FIFO-Queue** mit
  `pump()` (`watcher.ts`: `while (active < concurrency && queue.length)`). Für
  Jira wird die FIFO-Queue zur **Prio-Queue**: beim Freiwerden eines Slots zieht
  `pump()` nicht das älteste, sondern das Ticket mit höchster Jira-Priorität
  (Tie-Break: ältestes zuerst). Stichwort filtert *was überhaupt* rein darf,
  Priorität entscheidet *in welcher Reihenfolge* gestartet wird.

### (2) Radar-Stages statt Demo-Stages — ja

Die Demo erzwingt eine feste, geordnete Timeline
(`investigating → root_cause_found → fix_in_progress → ready_for_review → deployed`,
siehe `extensions.ts:34` + Reihenfolge-Guard `extensions.ts:191`). Radar dagegen
hat ein **Menü** (`implement → review → deliver`), bewusst ohne Gates.

Für den Jira-Flow nimmst du **Radars Step-Namen**, lässt sie aber im
**erzwungen-geordneten, auto-berichtenden Stil der Demo** laufen (weil hier
niemand live zuschaut und die Jira-Timeline sauber sein soll).

**Wichtig: `classify` ist ein Router, kein linearer Vorschritt.** Das war in
einer früheren Fassung dieser Skizze falsch dargestellt. Klassifikation entscheidet
*welche Lane* das Ticket nimmt — und eine davon ist `grill → spec → tickets`,
die dann pro Kind-Ticket in `implement → review → deliver` **auffächert**. Siehe
Abschnitt 2a.

Die inhaltlichen Stages liefert Radars Lane-Menü; die Demo liefert den
Mechanismus „Stage melden, Reihenfolge innerhalb einer Lane erzwingen, jeder
Übergang landet in der Timeline". Radars **Modellwahl pro Worker**
(`SIMPLE/MODERATE/COMPLEX → model`) und das **Lane-Klassifikat** bleiben erhalten.

### (2a) Klassifikation als Router — der genaue Weg

`classify` (ein Judge/LLM-Aufruf, kann Kev sein) ordnet jedes Ticket in genau
eine Lane ein — exakt Radars Tabelle aus dem `radar-lanes`-Skill:

```
                        ┌─ Lane 0 · Frage ──────▶ explore → Antwort als Jira-Kommentar, STOP (kein Code)
                        │
classify (Kev/LLM) ─────┼─ Lane 1 · kleine Änderung ─┐
                        │                            ├─▶ implement → review → mr_open → approval → merged
                        ├─ Lane 2 · Ticket klar ─────┘
                        │
                        └─ Lane 3 · Feature, vage/groß ─▶ grill (in Session) → spec → tickets ─┐ (fan-out)
                                                                                   │
                              erzeugt N Kind-Tickets in Jira ─────────────────────┘
                              jedes landet wieder im Poller (Lane 2), Prio geerbt
```

**Das Fan-out ist elegant selbsttragend:** Lane 3 erzeugt über den `ticketer`
echte Jira-Kind-Tickets (mit dem Stichwort-Label). Die laufen *nicht* inline
weiter — sie werden vom **selben Poller** beim nächsten Durchlauf als normale
Lane-2-Tickets aufgenommen, priorisiert und (bis `maxConcurrent`) parallel
abgearbeitet. Feature-Zerlegung speist sich also automatisch zurück in die
Warteschlange; kein Sonderpfad nötig.

### (2b) Interaktion in der Session, nicht über Jira

**Grundsätzliche Kanaltrennung:**

- **Die Agent-Session** (Chat / `dpi-tui` / Web-Hub) ist der Ort für *jede*
  Interaktion — Grill-Rückfragen, explorative Nachfragen, Scope-Schärfung. Das
  Hin und Her läuft live in der Session, genau wie bei Radar.
- **Jira** ist Trigger + Dokumentation: Status und am Ende *eine*
  **Zusammenfassung** (alle gestellten Fragen und ihre Antworten als ein
  Kommentar). **Kein Frage-Antwort-Ping-Pong über Jira-Kommentare.**

**Wie kommt der Mensch in die Session eines gepollten Tickets?** Über dasselbe
Muster wie die Demo: die Conversation ist **ownerlos**, und sobald der Agent eine
blockierende Rückfrage hat, signalisiert er „braucht einen Menschen"
(Notification / optional `voice.ts`, wie die „ready for review"-Ansage der Demo,
`config.ts:72`). Ein Mensch öffnet die Session im TUI oder Web-Hub und führt den
Grill live. Der Agent wartet derweil **idle** auf die nächste Eingabe — ein
normaler Conversation-Turn, der beim Warten nichts kostet und keinen Poll
braucht (anders als die Approval-Phase, die externen Zustand abfragt).

**Ablauf Lane 3 (vage) im Detail:**

1. `classify` → Lane 3, Beschreibung zu vage → Agent stellt **in der Session**
   die schärfsten blockierenden Fragen und signalisiert „wartet auf Mensch".
2. Mensch joint die Session (TUI/Web), beantwortet live, Agent bohrt nach —
   normales Radar-`grill`, voll interaktiv.
3. Grill fertig → Agent schreibt **einen** Jira-Kommentar: die komplette
   Frage/Antwort-Liste als Protokoll („Scope geklärt: F1 → A1, F2 → A2 …").
4. Weiter zu `spec → tickets`, Fan-out wie oben.

**Lane 0 (Frage) analog:** Die Diskussion läuft in der Session; nur die finale
Antwort/Erkenntnis wird als Jira-Kommentar dokumentiert.

**Auto-Spec weiterhin möglich:** Ist die Beschreibung schon reich genug, über-
springt `classify` den Grill ganz und geht direkt `spec → tickets` — dann ist gar
keine Interaktion nötig und es läuft unbeaufsichtigt durch.

**Slot-Hygiene:** Ein Ticket, das auf einen Menschen wartet, soll keinen der
`maxConcurrent` Arbeits-Slots blockieren. Default: Slot freigeben und das Ticket
re-queuen, sobald die Interaktion beginnt (alternativ: „waiting-for-human" zählt
nicht gegen das Limit).

**Judge-Gate bleibt davon getrennt (Punkt 4):** das ist der *billige Vorfilter*
vor dem Öffnen einer Session — „lohnt sich Automatik überhaupt?". Nur ein hartes
Nein dort schreibt direkt einen Jira-Kommentar ohne Session. Alles, was eine
echte Rückfrage ist, passiert in der Session.

**Erzwungene Ordnung gilt *innerhalb* einer Lane, nicht über Lanes hinweg.** Ein
Ticket wird genau einmal klassifiziert; danach erzwingt die Stage-Maschine die
Reihenfolge seiner Lane (Demo-Guard `extensions.ts:191`).

### (2c) Status-Mapping Lane → Jira

| Lane | interne Stages (in Session) | Jira-Spiegel (Status + Kommentar) |
|---|---|---|
| 0 Frage | `explore` + Diskussion | Status ggf. `Done`; Kommentar = finale Antwort |
| 1 kleine Änderung | `implement → review → mr_open → approval → merged` | `In Progress → In Review → Waiting Approval → Done` |
| 2 Ticket | wie Lane 1 | wie Lane 1 |
| 3 Feature | `grill` (live in Session) → `spec → tickets` | `Refining`; Kommentar = Grill-Protokoll (F/A) + Kind-Ticket-Links |
| 3-Kinder | fallen in Lane 2 | wie Lane 1 |

`update_ticket` (Analog `update_incident`) schreibt jeden Stage-Übergang:
Status-Transition **und** Kommentar. Interaktive Inhalte landen als *eine*
zusammengefasste Dokumentation, nicht als Dialog. Für Lane 3 schreibt der
`ticketer` zusätzlich die Kind-Ticket-Links ins Eltern-Ticket.

### (3) Fingerprint-Dedup — direkt übernehmbar

Demo: `openFingerprints: Set` + Prüfung *innerhalb* des `commit` gegen die
`Incidents`-Doc (`ops.ts:openIncident`), damit ein Doppel-Trigger nicht zwei
Agenten startet. Für Jira ist der Fingerprint **trivial = Ticket-Key** (`PROJ-123`).
Dazu der persistente `jira-store` (gesehene Keys), damit ein Neustart ein bereits
laufendes Ticket nicht erneut startet — exakt das `recover()`-Muster.

### (4) Judge-Gate — wiederverwenden

`judge.ts` (= Jev/Kev) entscheidet vor dem Start pro Ticket: *sinnvoll
automatisierbar? Grob genug Substanz, um überhaupt eine Session zu öffnen?* Nur
bei „ja" wird eine Conversation geöffnet. Ein hartes „nein" (z. B. leere
Beschreibung) schreibt einen Jira-Kommentar und parkt das Ticket. Alles
Darüber Hinausgehendes — echte Scope-Rückfragen — ist **kein** Judge-Thema, sondern
passiert interaktiv in der Session (Punkt 2b). So bleibt das Gate ein billiger
Vorfilter, kein Dialogkanal.

### (5) Approval-Phase — wie genehmigt man?

Kernmuster aus der Demo (`extensions.ts:242`, `DeployTask`):

> *„Each phase is checkpointed, so a backend restart resumes the deploy where it
> stood, including the wait for the engineer. Waiting polls a committed document;
> Durable Pi has no built-in signal."*

Die `approval`-Phase ist eine **durable Schleife**, die einen externen Zustand
pollt und zwischendurch `runtime.sleep`t — übersteht Neustarts, kostet nichts
während des Wartens.

**Beide Quellen werden parallel gepollt — wer zuerst kommt, gewinnt (first
wins).** Die Phase fragt in jedem Durchlauf *beide* Seiten ab und entscheidet auf
das erste eindeutige Signal:

- **(a) GitLab-MR-Approval.** `GET /merge_requests/:iid/approvals` → sobald
  `approved_by` nicht leer ist (bzw. `merge_status = can_be_merged`). Du drückst
  im GitLab schlicht „Approve".
- **(b) Jira-Kommentar-Approval.** Ticket-Kommentare auf ein Schlüsselwort
  (`/approve`, `/decline`). Näher an der Demo (die pollt die `Deploys`-Doc auf
  `declined`/`deploying`).

Entscheidungslogik pro Poll-Durchlauf:

```
if gitlab.approved || jira.hasComment("/approve")   → phase: merge
if gitlab.declinedLabel || jira.hasComment("/decline") → terminal: declined
else runtime.sleep(now + intervalMs)   // weiter warten, checkpointed
```

So kannst du **wahlweise im GitLab approven ODER einen Jira-Kommentar schreiben** —
beide Wege lösen dieselbe Phase aus. Welcher Kanal die Entscheidung ausgelöst hat,
wird in die Timeline/Jira-Kommentar geschrieben (Audit: „approved via GitLab-MR
von <user>" bzw. „approved via Jira-Kommentar von <user>"). Die Gegenprobe gilt
symmetrisch: ein `/decline` in Jira **oder** ein Decline-Label am MR beendet die
Phase terminal.

Es bleibt dieselbe checkpointed Polling-Schleife — nur werden jetzt zwei Quellen
abgefragt statt einer. **Interrupt/Cancel** killt die Phase sauber (Demo
`abort:`), nichts wird gemerged.

> Hinweis: `config.approvalMode` bleibt trotzdem sinnvoll — als `both` (Default),
> `gitlab-only` oder `jira-only`, falls ein Team einen Kanal bewusst abschalten
> will. Default ist `both`.

### (6) Status-Spiegelung — übernehmen

Jeder Stage-Übergang schreibt zurück: ein Tool `update_ticket` (Analog zu
`update_incident`) setzt Jira-Status/Transition **und** postet einen Kommentar
(„review: 0 Blocker, MR: <link>"). `verifyAndCommit` (`repo.ts`) beweist wie in
der Demo Test-rot-auf-`main` / grün-auf-Branch, bevor „ready/mr_open" gemeldet
wird. So ist die Jira-Timeline der Spiegel der internen Stage-Timeline.

### (7) Batch-ahead — vorhanden

Radar kennt das schon („mach durch bis MR" → keine Rückfragen pro Step, nur
echte Blocker). Im unbeaufsichtigten Jira-Flow ist **batch-ahead der Default**:
`implement → review → deliver(MR)` läuft ohne Zwischenfragen durch; der einzige
menschliche Halt ist die **Approval-Phase** (Punkt 5). Blocker oder Judge-„nein"
→ Jira-Kommentar + Stop.

---

## 3. Parallelität, Worktrees, Obergrenze

**Ja, mehrere Tickets laufen parallel** — und ja, **zwingend in getrennten
Worktrees.** Genau das macht die Demo heute pro Incident:

- Pro Ticket eine **eigene ownerlose Conversation** (`ops.ts:openIncident`) und
  ein **eigener git-Worktree** auf **eigenem Branch** (`repo.ts:ensureWorktree`,
  `git worktree add -b incident/<slug> <path> main`). Dadurch stören sich die
  Agenten nicht; jeder hat sein isoliertes Arbeitsverzeichnis.
- Branch-Namen/Worktree-Pfade pro Ticket-Key: `jira/<proj-123>`,
  `worktrees/<proj-123>`.

**Obergrenze gegen „hunderte parallel":** Die Backpressure existiert schon im
`pump()`-Gate des Watchers — `while (active < concurrency)`. Das ist der
natürliche Ort für die Config:

```
# config.ts (sinnvoller Default)
maxConcurrent: 3        # höchstens 3 Tickets gleichzeitig in Arbeit
pollIntervalMs: 30_000  # alle 30s Jira abfragen
```

Tickets über dem Cap bleiben **in der Prio-Queue** stehen (nicht gestartet);
sobald ein Agent `merged`/`declined` erreicht, zieht `pump()` das nächste —
höchste Priorität zuerst (Punkt 1). Das ist kein nackter Zähler, sondern echte
Warteschlangen-Backpressure: läuft die Flotte voll, stauen sich die Tickets
geordnet, statt das System zu überrennen.

---

## 4. End-to-End-Fluss (Zusammenfassung)

```
Jira (JQL: label=ai-flow ORDER BY priority DESC)
     │  jira-poller.poll()  (alle 30s)
     ▼
Judge-Gate (judge.ts)  ── nein ──▶ Jira-Kommentar „brauche X", stop
     │ ja
     ▼
Prio-Queue ── pump() (max 3 aktiv) ──▶ pro Ticket:
     │                                   • ownerlose Conversation
     │                                   • eigener Worktree jira/<key>
     ▼
classify (Router, Punkt 2a) ──┬── Lane 0 Frage ─▶ explore + Diskussion IN SESSION → Zusammenfassung als Jira-Kommentar, STOP
     │                        │
     │                        ├── Lane 3 vage ──▶ grill LIVE IN SESSION (Mensch joint) → F/A-Protokoll als Jira-Kommentar → spec → tickets
     │                        │
     │                        ├── Lane 3 reif ──▶ spec → tickets → N Kind-Tickets zurück in den Poller (fan-out)
     │                        │
     │                        └── Lane 1/2 ─────▶ Stage-Maschine (erzwungen geordnet):
     ▼                                              implement → review → mr_open
Stage-Maschine                                        │  (update_ticket spiegelt jeden Übergang)
     ▼
MergeTask.approval  ── durable Poll (BEIDE) ──▶ GitLab-MR „Approve" ODER Jira /approve
     │  (checkpointed: überlebt Backend-Neustart, kostet nichts beim Warten)
     ▼
merge → merged  ── Jira-Status + Kommentar mit MR-Link
```

Chat-Einstieg ist derselbe Apparat: Ein Chat-Ticket läuft durch Radars
Klassifikation in dieselbe Stage-Maschine — nur dass der Trigger ein Mensch im
Chat ist statt des Pollers.

---

## 5. Was NEU gebaut werden müsste (Scope-Ehrlichkeit)

Praktisch nur der Adapter-Rand; der Motor existiert:

1. `jira-poller.ts` — JQL-Poll + Prio-Queue (Umbau von `watcher.ts`).
2. Jira-REST-Aufrufe in `update_ticket` (Transition + Kommentar) und im
   Poll (Keyword/Prio lesen).
3. GitLab-REST im `MergeTask` (MR anlegen, Approvals pollen, mergen).
4. `jira-store.ts` — persistente Key-Dedup (Umbau von `watch-store.ts`).
5. Config-Felder `jql / pollIntervalMs / maxConcurrent / approvalMode`
   (`approvalMode` Default `both` — GitLab- und Jira-Approval parallel aktiv).

Unverändert übernehmbar: Durable-Harness, ownerlose Conversations,
Worktree-Handling, `verifyAndCommit`, das checkpointed Phasen-/Approval-Muster,
Fingerprint-Dedup, `recover()`, das `pump()`-Concurrency-Gate.

---

## 6. UI — fast 1:1 aus der Demo

Die Demo-UI ist bereits beinahe genau das Gewünschte. Zwei-Spalten-Layout
(`App.vue` → `<main class="workspace">`): links der aktive Agent, rechts die
Live-Spalte. Wir tauschen rechts nur den **Inhalt** aus.

### Rechte Spalte: die Tabelle bleibt — als Ticket-Feed

**Korrektur zu einer früheren Fassung:** die Tabelle (`log-head` / `log-scroll` /
`log-row`) wird **nicht** entfernt. Sie bleibt genau das, was sie in der Demo ist
— ein scrollender Live-Feed, in den der Poller läuft —, nur dass **eine Zeile
jetzt ein Ticket ist statt einer Log-Zeile.** Label ich in Jira ein Ticket mit
`ready-for-agent`, erscheint es beim nächsten Poll als neue Zeile im Feed
(append, exakt wie heute die Log-Zeilen via `stream.addEventListener("log")`).

**Spalten umgewidmet** (gleiche `log-row`-Struktur, andere Bedeutung):

| Demo-Spalte | Jira-Flow-Spalte | Quelle |
|---|---|---|
| `Time` | **Gefunden um** | Poll-Zeitpunkt (bzw. Jira `created`) |
| `Severity` | **Wichtigkeit** | Jira-Priorität (Highest→Low), gleiche Farbcodierung wie `sev` |
| `Service` | **Projekt / Epic** | Jira-Projekt oder Epic-Key (optional) |
| `Event` | **Ticket-Headline** | Jira-Summary |
| `Jev decision` | **Kev-Decision** | das `jev-chip`-Pendant → Kev-Label |

Die **Decision-Chips** sind exakt das heutige `jev-chip`-Muster (`NORMAL 1.00` →
jetzt z. B. `READY 0.92` / `NEEDS CLARIFICATION 0.78`), aufklappbar wie die
Log-Zeile heute (`expanded`), um Kevs Begründung + Wahrscheinlichkeiten zu zeigen.
Dein Wunsch — Uhrzeit, Wichtigkeit, Headline statt Event, Decision — ist damit
1:1 die umgewidmete Tabelle.

**Kev-Decisions** (ersetzen `normal/suspicious/incident`):

- `Ready to Start` — automatisierbar, genug Info, noch nicht gestartet
- `Needs Clarification` — zu vage, braucht Grill-in-Session
- `In Progress` — läuft, Agent arbeitet (Lane 1/2/3)
- `Waiting You` — Agent pausiert: Grill-Rückfrage **oder** Approval offen
- `In Review` / `Merged` / `Done`

**Zähler-Leiste** (`stream-stats`) oben: Counts pro Decision/Status
(`Ready` / `Needs Clarification` / `In Progress` / `Waiting You` / `Done`) statt
judged/normal/suspicious/incident.

**Aktive Tickets bleiben zusätzlich oben angepinnt:** die `stream-incident`-Karten
(Titel + Status-Label + `Open agent`) bleiben erhalten für die Tickets, die
gerade einen laufenden Agenten haben — genau wie heute die aktuell bearbeitete
Incident-Karte über den Log-Zeilen sitzt. So hast du beides: oben die
„in Arbeit"-Karten, darunter den vollständigen, scrollenden Ticket-Feed.

Die Label-Logik ist weiterhin das `:class="[status]"` + `STATUS_LABELS`- und
`jev-chip`-Muster, das `EventStream.vue` heute schon nutzt — nur mit den
Lane-/Kev-Status statt den Incident-Stufen.

### Klick-Verhalten: starten vs. öffnen

In der Demo starten Incidents **automatisch** (der Watcher öffnet sie). Du willst
manuelle Kontrolle — ein kleiner, sauberer Zusatz über den Ticket-Zustand:

- **Noch nicht gestartet** (`Ready to Start` / `Needs Clarification`): Zeile/Karte
  hat noch keine Conversation und keinen Worktree. Klick → **Start-Popup** (Modal):
  Modell/Thinking wählen (wie der Modell-Dropdown oben in `App.vue`), Kevs
  Lane-Vorschlag anzeigen, „Start". Das löst serverseitig genau `openIncident()`
  aus (ownerlose Conversation + Worktree + `kickoff`).
- **Läuft bereits**: Klick → `emit('open', conversationId)`, linke Spalte zeigt
  den Agent. Exakt das heutige Demo-Verhalten.

Optional per Config: `autoStart` — z. B. `Highest`-Prio sofort starten, Rest
manuell per Klick. Dieselbe `pump()`-Logik, nur dass ein Ticket unterhalb der
Auto-Schwelle im Zustand `Ready to Start` wartet, bis jemand klickt.

### Linke Spalte: unverändert — pro Ticket ein Agent

`AgentChat.vue` + `IncidentCard.vue` bleiben im Kern, nur umgelabelt:

- **Stage-Stepper** oben (`incident-steps` / die `Detected → … → Deployed`-Leiste
  im Screenshot) zeigt jetzt die **Lane-Stages**: für Lane 1/2
  `classify → implement → review → mr_open → approval → merged`; für Lane 3
  `classify → grill → spec → tickets`.
- **Agent-Timeline** (Tool-Calls, Nachrichten) — unverändert.
- **Approval-Karte** („Deploy waiting for your approval" im Screenshot) wird zur
  **„Merge waiting for your approval"** — mit `Approve`/`Decline`, plus Hinweis,
  dass auch GitLab-MR-Approve ODER Jira `/approve` sie auflöst (Punkt 5).
- **Prompt-Box** unten — hier promptest du, gibst Proof, führst den **Grill** live.
  Genau das Feld „Talk to the INC-0001 agent", nur „Talk to PROJ-123".

### Zusammengefasst

Ja — mit den Lanes-Anpassungen würde die UI so umgesetzt: rechts der scrollende
Ticket-Feed (Tabelle: Gefunden-um · Wichtigkeit · Projekt · Headline ·
Kev-Decision), darüber die „in Arbeit"-Karten; Klick startet (Popup) oder öffnet;
links der konkrete Ticket-Agent mit Stage-Stepper, Chat/Prompt, Proof und
Approval-Karte. Der echte Neubau ist klein: **die Tabelle rendert Ticket-Zeilen
statt Log-Zeilen, und eine Zeile bekommt einen „noch-nicht-gestartet"-Zustand +
Start-Modal** — der Rest ist Umlabeln bestehender Komponenten.

**Nicht Teil der Demo-UI, aber naheliegend:** ein Kanban-Layout
(`Ready` | `In Progress` | `Waiting You` | `Done`) als alternative Ansicht der
rechten Liste — rein kosmetisch über denselben Ticket-Status.
