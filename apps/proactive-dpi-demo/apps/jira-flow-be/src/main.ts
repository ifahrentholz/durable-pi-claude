import { config } from "./config.ts";
import express from "express";
import { createServer } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { appDir, dataDir } from "./paths.ts";
import { Jira } from "./jira.ts";
import { GitLab } from "./gitlab.ts";
import { Classifier } from "./classify.ts";
import { Ops } from "./ops.ts";
import { Poller } from "./poller.ts";
import { branchReview } from "./repo.ts";
import type { Ticket } from "./types.ts";

mkdirSync(dataDir, { recursive: true });

const jira = new Jira();
const gitlab = new GitLab();
const classifier = new Classifier();
const ops = await Ops.open(jira, gitlab);

const poller = new Poller(
  jira,
  classifier,
  () => false,
  (discovery) =>
    void ops
      .recordDiscovered(discovery)
      .catch((e) => console.error(`[poller] could not record ${discovery.ticket.key}:`, e instanceof Error ? e.message : e)),
);
poller.prime(await ops.trackedKeys());
// EventEmitter 'error' with no listener would crash the process; log and keep polling.
poller.on("error", (e) => console.error("[poller]", e instanceof Error ? e.message : e));
poller.start();

/** Queue counts the UI shows in its stats row. */
function stats(tickets: Ticket[]) {
  const by = (fn: (t: Ticket) => boolean) => tickets.filter(fn).length;
  return {
    total: tickets.length,
    ready: by((t) => t.stage === "discovered" && t.classification?.decision === "ready"),
    needsClarification: by(
      (t) => t.stage === "discovered" && t.classification?.decision === "needs_clarification",
    ),
    inProgress: by((t) => !!t.conversationId && ["starting", "classify", "implement", "review"].includes(t.stage)),
    // Waiting for a human: a grill question, an open MR, an approval.
    waiting: by((t) => ["grill", "mr_open", "approval"].includes(t.stage)),
    done: by((t) => ["merged", "answered"].includes(t.stage)),
    blocked: by((t) => t.stage === "blocked"),
  };
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

const allowedHosts = new Set([`localhost:${config.port}`, `127.0.0.1:${config.port}`, `[::1]:${config.port}`]);
if (config.host === "0.0.0.0") {
  const name = hostname().toLowerCase();
  allowedHosts.add(`${name}:${config.port}`);
  for (const addresses of Object.values(networkInterfaces()))
    for (const a of addresses ?? []) if (a.family === "IPv4") allowedHosts.add(`${a.address}:${config.port}`);
} else allowedHosts.add(`${config.host}:${config.port}`);
app.use("/api", (req, res, next) => {
  if (!allowedHosts.has((req.headers.host ?? "").toLowerCase())) {
    res.status(403).json({ error: "Unknown host" });
    return;
  }
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) {
    res.status(403).json({ error: "Cross-origin requests are not allowed" });
    return;
  }
  if (!["GET", "HEAD"].includes(req.method) && !req.is("application/json")) {
    res.status(415).json({ error: "JSON required" });
    return;
  }
  next();
});

function sse(res: express.Response) {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  return (event: string, data: unknown) => {
    if (res.writableLength > 2_000_000) res.end();
    else res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

app.get("/api/config", (_req, res) => {
  const models = ops.modelList();
  res.json({
    models,
    defaultModel: models.find((m) => m.id === config.model),
    rootConversationId: ops.root.id,
    judge: poller.judge,
    pollIntervalSec: config.pollIntervalSec,
    label: config.label,
    maxConcurrent: config.maxConcurrent,
    approvalMode: config.approvalMode,
    autoMerge: config.autoMerge,
    maxReviewRounds: config.maxReviewRounds,
    reviewQuick: config.reviewQuick,
    projects: Object.keys(config.projects),
    version: "0.1.0",
  });
});

app.get("/api/stream", async (_req, res) => {
  const send = sse(res);
  const tickets = await ops.tickets();
  send("init", { tickets, stats: stats(tickets), at: Date.now(), polledAt: poller.lastPolledAt });
  const onTicket = async (ticket: unknown) => {
    send("ticket", ticket);
    send("status", { stats: stats(await ops.tickets()), at: Date.now() });
  };
  const onPolled = (p: unknown) => send("polled", p);
  ops.on("ticket", onTicket);
  poller.on("polled", onPolled);
  const timer = setInterval(async () => send("status", { stats: stats(await ops.tickets()), at: Date.now() }), 5000);
  _req.on("close", () => {
    clearInterval(timer);
    ops.off("ticket", onTicket);
    poller.off("polled", onPolled);
  });
});

// One conversation's committed view, pushed after every commit.
app.get("/api/conversations/:cid/events", async (req, res) => {
  const cid = Number(req.params.cid);
  await ops.conversation(cid);
  const send = sse(res);
  let closed = false,
    fetching = false,
    dirty = true,
    previous = "",
    lastSent = 0;
  const unsubscribe = ops.harness.subscribeCommits(() => {
    dirty = true;
  });
  const tick = async () => {
    if (closed || fetching || (!dirty && Date.now() - lastSent < 15000)) return;
    fetching = true;
    dirty = false;
    try {
      const { serverTime, ...stable } = await ops.snapshot(cid);
      const data = JSON.stringify(stable);
      if (!closed && (data !== previous || Date.now() - lastSent > 15000)) {
        send("snapshot", { ...stable, serverTime });
        previous = data;
        lastSent = Date.now();
      }
    } catch (e) {
      if (!closed) {
        send("fault", { error: String(e) });
        res.end();
      }
    } finally {
      fetching = false;
    }
  };
  const timer = setInterval(() => void tick(), 300);
  req.on("close", () => {
    closed = true;
    clearInterval(timer);
    unsubscribe();
  });
  void tick();
});

app.post("/api/conversations/:cid/:action", async (req, res) => {
  res.json(await ops.action(Number(req.params.cid), req.params.action, req.body ?? {}));
});

// Start the agent for a discovered ticket (manual start, the default). Optional model override.
app.post("/api/tickets/:key/start", async (req, res) => {
  const model = typeof req.body?.model === "string" ? req.body.model : undefined;
  const lane = typeof req.body?.lane === "string" ? req.body.lane : undefined;
  const conversationId = await ops.startTicket(req.params.key, model, lane);
  res.json({ conversationId });
});

app.get("/api/tickets/:key/review", async (req, res) => {
  const ticket = (await ops.tickets()).find((t) => t.key === req.params.key);
  if (!ticket?.repo) throw Error("Ticket or repo not found");
  res.json(await branchReview(ticket.repo));
});

app.post("/api/merges/:id/decide", async (req, res) => {
  const { approved, note } = req.body ?? {};
  if (typeof approved !== "boolean") throw Error("approved must be true or false");
  await ops.decideMerge(Number(req.params.id), approved, typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null);
  res.json({ ok: true });
});

app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found" }));
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[request]", err.message);
  res.status(400).json({ error: err.message });
});

const feDir = resolve(appDir, "../jira-flow-fe");
const server = createServer(app);
let vite: Awaited<ReturnType<(typeof import("vite"))["createServer"]>> | undefined;
if (config.dev) {
  const { createServer: createVite } = await import("vite");
  vite = await createVite({
    configFile: join(feDir, "vite.config.ts"),
    server: { middlewareMode: true, hmr: { server } },
  });
  app.use(vite.middlewares);
} else if (existsSync(join(feDir, "dist"))) {
  app.use(express.static(join(feDir, "dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(join(feDir, "dist/index.html")));
}

server.listen(config.port, config.host, () => {
  console.log(
    `Jira Flow: http://localhost:${config.port}\n  judge ${poller.judge}  model ${config.provider}/${config.model}  poll ${config.pollIntervalSec}s  label "${config.label}"  max ${config.maxConcurrent}  approval ${config.approvalMode}`,
  );
  const projects = Object.keys(config.projects);
  console.log(projects.length ? `  projects: ${projects.join(", ")}` : "  ⚠ no projects mapped — edit jira-flow.config.json");
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  poller.stop();
  server.close();
  server.closeAllConnections();
  await vite?.close();
  await ops.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
