// Tool approvals (this fork): a pi-durable extension whose beforeTool hook holds every call that changes things
// (bash, write, edit, start_session, run_durable_job, ping_on_call_engineer) until a person decides, unless one of
// the session's rules allows it.
//
// The request is a durable record in the agent's `demo.approvals` document, keyed by tool call id: a restart or a
// crash while the call waits re-runs the hook, which finds the record and keeps waiting, or applies the decision
// that was made meanwhile. Nothing runs twice and nobody is asked twice. The web client shows the request at the
// tool call; the agent receives a denial (with the person's note) as the tool's error result.
import type { Context } from "@earendil-works/chord";
import { defineDoc, defineExtension, hook, ToolTask, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import {
  APPROVAL_RULES_DOC,
  APPROVAL_TOOLS,
  APPROVALS_DOC,
  DEFAULT_RULES,
  describeCall,
  ruleAllows,
  suggestRule,
  type ApprovalDecision,
  type ApprovalItem,
  type ApprovalRulesDoc,
  type ApprovalsDoc,
  type PermissionMode,
  PERMISSION_MODES,
} from "../../dpi-sdk/src/approvals.js";
import type { Assessment } from "./addons.js";

export const Approvals = defineDoc<ApprovalsDoc>({
  kind: APPROVALS_DOC,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial", // a fork starts without its parent's open questions
  initial: () => ({ items: {} }),
});

export const ApprovalRules = defineDoc<ApprovalRulesDoc>({
  kind: APPROVAL_RULES_DOC,
  version: 1,
  scope: "session",
  initial: () => ({ allow: [...DEFAULT_RULES] }),
});

export const APPROVALS_INFO = {
  name: "approvals",
  title: "Approvals",
  description:
    "Holds bash and other calls that change things until you allow them in the chat. Rules (edit, read-only jira/glab/gh/git commands, and whatever you allow always) skip the question. Turn it off to let this agent run everything.",
};

const POLL_MS = 400;

/**
 * `commit` runs a Session commit; the hook uses it to write the request, since hooks only read.
 * `assess` asks the judge whether a shell command may run unasked (auto mode).
 */
export function createApprovals(deps: {
  commit: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  assess?: (command: string) => Promise<Assessment | undefined>;
}) {
  return defineExtension({
    name: "approvals",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, ctx) => {
          if (!APPROVAL_TOOLS.includes(call.name)) return;
          const args = (call.arguments ?? {}) as Record<string, unknown>;
          const conversationId = api.conversationId;

          const settings = await api.snapshot(ApprovalRules, ctx);
          const mode: PermissionMode = settings?.mode ?? "ask";
          if (mode === "yolo") return;
          const rules = settings?.allow ?? DEFAULT_RULES;
          if (rules.some((rule) => ruleAllows(rule, call.name, args))) return;

          // A decision made before a restart still counts; an open request keeps waiting.
          let item = (await api.snapshot(Approvals, conversationId, ctx))?.items[call.id];
          if (!item) {
            // Auto mode: the judge decides shell commands; it runs once per call, its verdict is stored before the call.
            const verdict = mode === "auto" && call.name === "bash" && deps.assess ? await deps.assess(String(args.command ?? "")) : undefined;
            item = await deps.commit(async (tx) => {
              const doc = await tx.doc(Approvals, conversationId);
              doc.items[call.id] ??= {
                callId: call.id,
                taskId: api.taskId as number,
                tool: call.name,
                summary: describeCall(call.name, args),
                rules: [suggestRule(call.name, args)],
                status: verdict?.auto ? "auto" : "pending",
                at: Date.now(),
                ...(verdict ? { reason: verdict.reason } : mode === "auto" && call.name === "bash" ? { reason: "No judge reachable: asking instead" } : {}),
                ...(verdict?.auto ? { decidedAt: Date.now() } : {}),
              };
              return JSON.parse(JSON.stringify(doc.items[call.id])) as ApprovalItem;
            });
          }
          while (item.status === "pending") {
            await sleep(POLL_MS, ctx);
            item = (await api.snapshot(Approvals, conversationId, ctx))?.items[call.id] ?? item;
          }
          if (item.status === "denied")
            return {
              block: `The user denied this ${call.name} call.${item.message ? ` Their note: ${item.message}` : ""} Do not retry it unchanged; ask or take another approach.`,
            };
        },
      }),
    ],
  });
}

/** Record a decision; "always" also stores the call's rules for the whole session. */
export async function decideApproval(
  tx: Tx,
  conversationId: ConversationId,
  callId: string,
  decision: ApprovalDecision,
  message?: string,
): Promise<ApprovalItem | undefined> {
  const doc = await tx.doc(Approvals, conversationId);
  const item = doc.items[callId];
  if (!item || item.status !== "pending") return undefined;
  item.status = decision === "deny" ? "denied" : decision === "always" ? "always" : "allowed";
  item.decidedAt = Date.now();
  if (message?.trim()) item.message = message.trim().slice(0, 2000);
  if (decision === "always") {
    const rules = await tx.doc(ApprovalRules);
    for (const rule of item.rules) if (!rules.allow.includes(rule)) rules.allow.push(rule);
  }
  return JSON.parse(JSON.stringify(item)) as ApprovalItem;
}

export async function editRules(tx: Tx, change: { add?: string[]; remove?: string[]; mode?: string }): Promise<ApprovalRulesDoc> {
  const rules = await tx.doc(ApprovalRules);
  if (change.mode !== undefined) {
    if (!PERMISSION_MODES.includes(change.mode as PermissionMode)) throw Error(`mode must be one of ${PERMISSION_MODES.join(", ")}`);
    rules.mode = change.mode as PermissionMode;
  }
  for (const rule of change.add ?? []) {
    const r = rule.trim();
    if (r && /^[\w-]+(\(.*\))?$/s.test(r) && !rules.allow.includes(r)) rules.allow.push(r);
  }
  for (const rule of change.remove ?? []) {
    const i = rules.allow.indexOf(rule);
    if (i >= 0) rules.allow.splice(i, 1);
  }
  return { allow: [...rules.allow], mode: rules.mode ?? "ask" };
}

function sleep(ms: number, ctx: Context) {
  return new Promise<void>((resolve, reject) => {
    const signal = ctx.abortSignal;
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
