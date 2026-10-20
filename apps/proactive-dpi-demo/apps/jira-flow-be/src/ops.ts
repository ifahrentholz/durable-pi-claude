// One Durable Pi harness for the whole flow. Every started ticket gets its own ownerless conversation,
// opened in the same commit as its durable record, working in its own git worktree.
import { EventEmitter } from "node:events";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { claudeCodeModels, installClaudeCode } from "../../../../dpi-backend/src/claude-code.ts";
import {
  Harness,
  configure,
  createRegistry,
  type Conversation,
  type ConversationId,
  type ModelRef,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { lockFile } from "../../../shared/lock.ts";
import { config } from "./config.ts";
import { agentDbPath, demoDir } from "./paths.ts";
import { Merges, Reviews, Tickets, createExtensions } from "./extensions.ts";
import { LANES, planFor, playbook, reviewBrief, reviewResult } from "./lanes.ts";
import { prepareWorktree } from "./repo.ts";
import type { Jira } from "./jira.ts";
import type { Discovery } from "./poller.ts";
import type { Lane, Stage, Tier, Ticket } from "./types.ts";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];
/** Stages in which a ticket's agent works and holds one of the maxConcurrent slots. */
const ACTIVE: Stage[] = ["starting", "classify", "implement", "review", "approval"];

/** The model to run a ticket on, from its Kev tier, clamped to the configured floor/ceiling. */
function modelForTier(tier: Tier | undefined): string {
  if (!tier) return config.fallback;
  return config.tiers[tier.toLowerCase() as Lowercase<Tier>] ?? config.fallback;
}

export class Ops extends EventEmitter {
  private constructor(
    readonly harness: Harness,
    readonly root: Conversation,
    readonly models: ReturnType<typeof createModels>,
    private readonly extensions: ReturnType<typeof createExtensions>,
    private readonly unlock: () => void,
  ) {
    super();
  }

  static async open(jira: Jira, gitlab: import("./gitlab.ts").GitLab) {
    const models = createModels();
    if (config.provider === "claude-code") {
      installClaudeCode(models as never);
      if (!claudeCodeModels.some((m) => m.id === config.model))
        throw Error(`Claude Code has no model ${config.model}. One of ${claudeCodeModels.map((m) => m.id).join(", ")}`);
    } else {
      const provider = openrouterProvider();
      models.setProvider(provider);
    }
    let ops: Ops | undefined;
    const extensions = createExtensions({
      jira,
      gitlab,
      ticketChanged: (ticket, announce) => ops?.ticketChanged(ticket, announce),
      reviewRequested: (id) => void ops?.startReview(id),
      reviewFinished: (id) => void ops?.deliverReview(id),
    });
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(extensions.TicketAgent);
    registry.install(extensions.ReviewerAgent);
    registry.install(extensions.Desk);

    const unlock = lockFile(`${agentDbPath}.lock`);
    try {
      const shellEnv = Object.fromEntries(
        ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "TERM", "SSH_AUTH_SOCK"].flatMap((k) =>
          process.env[k] ? [[k, process.env[k]]] : [],
        ),
      );
      const harness = await Harness.open(
        await openNodeSqliteStorage(agentDbPath),
        {
          models,
          registry,
          env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? demoDir, shellEnv }),
          settings: {
            progress: { partialIntervalMs: 100, outputIntervalMs: 100 },
            toolExecution: "sequential",
          },
          onReport: (e) => console.error("[durable]", e),
        },
        ctx,
      );
      const root = await harness.root(ctx, {
        agent: {
          model: { provider: config.provider, modelId: config.model },
          thinkingLevel: config.thinking,
          extensions: [extensions.Desk],
          cwd: demoDir,
        },
      });
      ops = new Ops(harness, root, models, extensions, unlock);
      harness.resume();
      await ops.recover();
      return ops;
    } catch (e) {
      unlock();
      throw e;
    }
  }

  async tickets(): Promise<Ticket[]> {
    const doc = await this.harness.snapshot(Tickets, ctx);
    return Object.values(doc?.items ?? {}).sort((a, b) => b.discoveredAt - a.discoveredAt) as Ticket[];
  }

  /** Keys with a durable record, so the poller does not re-discover them. */
  async trackedKeys(): Promise<string[]> {
    return (await this.tickets()).map((t) => t.key);
  }

  /**
   * How many agents are actively working. The concurrency cap counts these. A ticket in the grill waits for the
   * engineer and an open MR waits for a human merge, so neither holds a slot.
   */
  async runningCount(): Promise<number> {
    return (await this.tickets()).filter((t) => t.conversationId && ACTIVE.includes(t.stage)).length;
  }

  /**
   * After a restart: re-attach every started ticket's worktree and re-kick its brief, then pick up every review
   * round where it stood. All submissions carry request ids, so nothing is sent twice.
   */
  private async recover() {
    for (const ticket of await this.tickets()) {
      if (!ticket.conversationId || !ticket.repo) continue;
      try {
        await this.setUp(ticket);
      } catch (e) {
        console.error(`[ops] recover ${ticket.key}:`, e instanceof Error ? e.message : e);
      }
    }
    const reviews = await this.harness.snapshot(Reviews, ctx);
    for (const review of Object.values(reviews?.items ?? {})) {
      await (review.status === "pending" ? this.startReview(review.id) : this.deliverReview(review.id));
    }
  }

  /** Worktree first, then the brief. A ticket still "starting" moves to its lane's first stage once the worktree exists. */
  private async setUp(ticket: Ticket) {
    await prepareWorktree(ticket.repo!);
    if (ticket.stage === "starting") {
      if (ticket.plan?.grill)
        await this.moveTicket(ticket.key, "starting", "grill", "Worktree ready. Grill: the agent sharpens the scope with you in the session.");
      else
        await this.moveTicket(ticket.key, "starting", "classify", `Worktree ready on ${ticket.repo!.branch}. Agent is reading the ticket.`);
    }
    await this.kickoff(ticket);
  }

  /** Commit a stage change for a ticket (only if it is still in `from`, when given) and announce it. */
  private async moveTicket(key: string, from: Stage | null, to: Stage, summary: string) {
    const updated = await this.harness.commit(async (tx) => {
      const item = (await tx.doc(Tickets)).items[key];
      if (!item || (from && item.stage !== from)) return null;
      item.stage = to;
      item.summary = summary;
      item.updatedAt = Date.now();
      item.timeline.push({ at: item.updatedAt, stage: to, summary });
      return JSON.parse(JSON.stringify(item)) as Ticket;
    }, ctx);
    if (updated) this.emit("ticket", updated);
  }

  /** The poller found a new ticket. Store it as a discovered record (no agent yet) and announce it. */
  async recordDiscovered({ ticket }: Discovery) {
    const stored = await this.harness.commit(async (tx) => {
      const doc = await tx.doc(Tickets);
      if (doc.items[ticket.key]) return doc.items[ticket.key];
      doc.items[ticket.key] = ticket;
      return ticket;
    }, ctx);
    this.emit("ticket", stored);
  }

  /** Start the agent for a discovered ticket. Enforces the concurrency cap. Returns the conversation id. */
  async startTicket(key: string, modelOverride?: string, laneOverride?: string) {
    if (laneOverride && !LANES.includes(laneOverride as Lane)) throw Error(`Unknown lane ${laneOverride}`);
    const running = await this.runningCount();
    if (running >= config.maxConcurrent)
      throw Error(`At capacity: ${running}/${config.maxConcurrent} tickets running. Wait for one to finish.`);

    const current = (await this.tickets()).find((t) => t.key === key);
    if (!current) throw Error(`Unknown ticket ${key}`);
    if (current.conversationId) return current.conversationId;
    if (!current.repo) throw Error(`No repo mapping for ${key}.`);

    const modelId = modelOverride ?? modelForTier(current.classification?.tier);
    const lane = (laneOverride as Lane | undefined) ?? current.classification?.lane ?? "ticket";
    const plan = planFor(lane, current.classification?.decision);

    // Create the conversation + record and return immediately: the UI shows the "starting" state from the
    // SSE event at once. Clone, worktree and brief run in the background (async git, so the server stays live).
    const { ticket, created } = await this.harness.commit(async (tx) => {
      const doc = await tx.doc(Tickets);
      const item = doc.items[key];
      // A second click raced the first: keep the first agent.
      if (item.conversationId) return { ticket: JSON.parse(JSON.stringify(item)) as Ticket, created: false };
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, conversation.id, {
        model: { provider: config.provider, modelId },
        thinkingLevel: config.thinking,
        extensions: [CodingTools, this.extensions.TicketAgent],
        cwd: item.repo!.worktree,
        instructions: playbook(item as Ticket, lane, plan),
      });
      item.conversationId = Number(conversation.id);
      item.lane = lane;
      item.plan = plan;
      item.stage = "starting";
      item.startedAt = Date.now();
      item.updatedAt = item.startedAt;
      item.summary = `Preparing worktree (${lane} lane, model ${modelId})...`;
      item.timeline.push({ at: item.startedAt, stage: "starting", summary: item.summary });
      return { ticket: JSON.parse(JSON.stringify(item)) as Ticket, created: true };
    }, ctx);

    if (!created) return ticket.conversationId;
    this.emit("ticket", ticket);
    void this.startInBackground(ticket, modelId);
    return ticket.conversationId;
  }

  /** Background part of a start. Never throws: a failure marks the ticket blocked with the reason. */
  private async startInBackground(ticket: Ticket, modelId: string) {
    try {
      await this.setUp(ticket);
      console.log(`[ops] ${ticket.key} started on ${modelId}, branch ${ticket.repo!.branch}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[ops] start ${ticket.key}:`, message);
      await this.moveTicket(ticket.key, null, "blocked", `Could not start: ${message}`).catch((err) =>
        console.error(`[ops] start ${ticket.key}: could not record the failure:`, err),
      );
    }
  }

  private async kickoff(ticket: Ticket) {
    const conversation = await this.harness.conversation(ticket.conversationId as unknown as ConversationId, ctx);
    if (!conversation) throw Error(`${ticket.key} lost its conversation`);
    await conversation.submit(
      { type: "input", content: this.brief(ticket), requestId: `ticket:${ticket.key}:brief` },
      ctx,
    );
  }

  private brief(ticket: Ticket) {
    const c = ticket.classification;
    return `${ticket.key} — ${ticket.title}

Priority: ${ticket.priority}. Kev: ${c?.tier ?? "?"} / lane ${c?.lane ?? "?"} / ${c?.decision ?? "?"}. Running in the ${ticket.lane ?? c?.lane ?? "ticket"} lane.

Jira description (the spec):
${ticket.description || "(no description)"}

Your worktree ${ticket.repo?.worktree} is on branch ${ticket.repo?.branch}, created from ${ticket.repo?.defaultBranch}. Work through the steps of your lane.`;
  }

  /**
   * Start (or resume) the reviewer conversation of a review round. Its own ownerless conversation on the pinned
   * reviewer model, created and recorded in one commit; the brief goes out with a request id, so exactly once.
   */
  async startReview(reviewId: string) {
    try {
      const started = await this.harness.commit(async (tx) => {
        const review = (await tx.doc(Reviews)).items[reviewId];
        const ticket = (await tx.doc(Tickets)).items[review?.ticketKey ?? ""];
        if (!review || !ticket?.repo || review.status !== "pending") return null;
        if (!review.reviewerConversationId) {
          const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
          await configure(tx, conversation.id, {
            model: { provider: config.provider, modelId: config.reviewerModel },
            thinkingLevel: config.thinking,
            extensions: [CodingTools, this.extensions.ReviewerAgent],
            cwd: ticket.repo.worktree,
            instructions: `You review ${ticket.key}, round ${review.round}.`,
          });
          review.reviewerConversationId = Number(conversation.id);
          if (ticket.review?.round === review.round) ticket.review.reviewerConversationId = review.reviewerConversationId;
        }
        return {
          cid: review.reviewerConversationId,
          brief: reviewBrief(ticket as Ticket, review, config.projects[ticket.project]?.testCommand ?? null),
          ticket: JSON.parse(JSON.stringify(ticket)) as Ticket,
        };
      }, ctx);
      if (!started) return;
      this.emit("ticket", started.ticket);
      const reviewer = await this.conversation(started.cid);
      await reviewer.submit({ type: "input", content: started.brief, requestId: `review:${reviewId}:brief` }, ctx);
    } catch (e) {
      console.error(`[ops] review ${reviewId}:`, e instanceof Error ? e.message : e);
    }
  }

  /** Hand a finished review round to the ticket agent as its next message (queued if it is still busy). */
  async deliverReview(reviewId: string) {
    try {
      const review = (await this.harness.snapshot(Reviews, ctx))?.items[reviewId];
      if (!review || review.status !== "done" || !review.verdict) return;
      const blocked = review.verdict === "changes_requested" && (review.attempt ?? review.round) >= config.maxReviewRounds;
      const coder = await this.conversation(review.coderConversationId);
      await coder.submit(
        { type: "input", content: reviewResult(review, blocked), requestId: `review:${reviewId}:result` },
        ctx,
      );
    } catch (e) {
      console.error(`[ops] deliver review ${reviewId}:`, e instanceof Error ? e.message : e);
    }
  }

  private ticketChanged(ticket: Ticket, _announce: boolean) {
    this.emit("ticket", ticket);
  }

  async conversation(cid: number) {
    const conversation = await this.harness.conversation(cid as unknown as ConversationId, ctx);
    if (!conversation) throw Error("Conversation not found");
    return conversation;
  }

  modelList() {
    if (config.provider === "claude-code")
      return claudeCodeModels.map((m) => ({
        id: m.id,
        provider: config.provider,
        name: m.name,
        tier: "S+",
        icon: "anthropic.png",
        contextWindow: m.contextWindow,
      }));
    return [];
  }

  async snapshot(cid: number) {
    const conversation = await this.conversation(cid);
    const view = await conversation.viewState(ctx);
    try {
      const [tickets, agent, merges] = await Promise.all([
        this.tickets(),
        conversation.agent(ctx),
        this.harness.snapshot(Merges, ctx),
      ]);
      return {
        conversationId: cid,
        view: view.value,
        tickets,
        merges: Object.values(merges?.items ?? {}).filter((m) => m.conversationId === cid),
        tools: agent.tools.map((t) => t.name),
        serverTime: Date.now(),
      };
    } finally {
      view.dispose();
    }
  }

  async action(cid: number, action: string, body: Record<string, unknown>) {
    const conversation = await this.conversation(cid);
    switch (action) {
      case "send": {
        if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 100_000)
          throw Error("Enter a message under 100,000 characters");
        if (!["steer", "followUp", "reject"].includes(String(body.whenBusy))) throw Error("Invalid queue mode");
        if (typeof body.requestId !== "string" || body.requestId.length > 128) throw Error("requestId required");
        const submission = await conversation.submit(
          {
            type: "input",
            content: body.content,
            requestId: body.requestId,
            whenBusy: body.whenBusy as "steer" | "followUp" | "reject",
          },
          ctx,
        );
        return { id: submission.id };
      }
      case "interrupt":
        await conversation.abort(ctx);
        return { ok: true };
      case "withdraw":
        return {
          status: await this.harness.abortSubmission(Number(body.submissionId) as SubmissionId, ctx, conversation.id),
        };
      case "configure": {
        const model = body.model as ModelRef | undefined;
        if (model && (model.provider !== config.provider || !this.models.getModel(config.provider, model.modelId)))
          throw Error("Choose a model from the list");
        if (body.thinkingLevel !== undefined && !THINKING.includes(String(body.thinkingLevel)))
          throw Error("Invalid thinking level");
        await conversation.configure(
          { ...(model ? { model } : {}), ...(body.thinkingLevel ? { thinkingLevel: body.thinkingLevel as "low" } : {}) },
          ctx,
        );
        return { ok: true };
      }
      default:
        throw Error("Unknown action");
    }
  }

  /** The engineer's merge decision from the UI. The merge task picks it up from the committed document. */
  async decideMerge(id: number, approved: boolean, note: string | null) {
    await this.harness.commit(async (tx) => {
      const merge = (await tx.doc(Merges)).items[String(id)];
      if (!merge) throw Error("Merge not found");
      if (merge.status !== "awaiting_approval") throw Error(`This merge is already ${merge.status}`);
      merge.status = approved ? "merging" : "declined";
      merge.approvedVia = approved ? merge.approvedVia : null;
      merge.decidedAt = Date.now();
      merge.note = note;
    }, ctx);
  }

  async close() {
    try {
      await this.harness.close(ctx);
    } finally {
      this.unlock();
    }
  }
}
