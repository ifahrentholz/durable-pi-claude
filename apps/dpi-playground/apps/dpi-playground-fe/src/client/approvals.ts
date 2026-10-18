// Tool approvals in the web client (this fork): the agent's `demo.approvals` document, the decision actions,
// and the session's rules that skip the question.
import { computed, ref } from "vue";
import { APPROVALS_DOC, type ApprovalDecision, type ApprovalItem, type ApprovalsDoc, type PermissionMode } from "@sdk/approvals";
import { agentHandle, agentState, attempt, notify, sessionSummary } from "./store";

/** Every approval request of the selected agent, oldest first. */
export const approvals = computed<ApprovalItem[]>(() => {
  const doc = agentState.value.docs[APPROVALS_DOC] as ApprovalsDoc | undefined;
  return Object.values(doc?.items ?? {}).sort((a, b) => a.at - b.at);
});
export const pendingApprovals = computed(() => approvals.value.filter((a) => a.status === "pending"));
export const approvalFor = (callId: string) => approvals.value.find((a) => a.callId === callId);

export const deciding = ref<string>();

export async function decideTool(item: ApprovalItem, decision: ApprovalDecision, message?: string) {
  if (deciding.value) return;
  deciding.value = item.callId;
  try {
    const done = await attempt(() =>
      agentHandle.value!.demo(`approvals/${encodeURIComponent(item.callId)}`, { decision, ...(message ? { message } : {}) }),
    );
    if (done && decision === "always") notify(`Allowed from now on: ${item.rules.join(", ")}`);
  } finally {
    deciding.value = undefined;
  }
}

/** Scroll the chat to the oldest open request. */
export function revealApproval() {
  const first = pendingApprovals.value[0];
  if (first)
    document.querySelector(`[data-approval="${CSS.escape(first.callId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

type RulesResponse = { allow: string[]; mode: PermissionMode; judge: string | null };

export async function loadRules(): Promise<string[] | undefined> {
  return (await attempt(() => agentHandle.value!.demo<RulesResponse>("approval-rules", undefined, "GET")))?.allow;
}

export async function editRules(change: { add?: string; remove?: string }): Promise<string[] | undefined> {
  return (await attempt(() => agentHandle.value!.demo<RulesResponse>("approval-rules", change)))?.allow;
}

// ---------- permission mode (session-wide): ask, auto, yolo

/** The selected session's mode, live from the device tree. */
export const permissionMode = computed<PermissionMode>(() => sessionSummary.value?.permissionMode ?? "ask");
/** Which judge auto mode asks (null: none configured, auto acts like ask). */
export const judgeLabel = ref<string | null>();

export async function loadJudge() {
  judgeLabel.value = (await agentHandle.value?.demo<RulesResponse>("approval-rules", undefined, "GET").catch(() => undefined))?.judge ?? null;
}

export const MODE_TEXT: Record<PermissionMode, string> = {
  ask: "Every call that changes things waits for you, unless a rule allows it.",
  auto: "Kev lets local, reversible shell commands run. Destructive commands and anything with an effect outside this machine (push, deploy, publish, POST, tickets) still wait for you.",
  yolo: "Nothing asks. Every agent of this session runs every command.",
};

export async function setPermissionMode(mode: PermissionMode) {
  const done = await attempt(() => agentHandle.value!.demo<RulesResponse>("approval-rules", { mode }));
  if (done) notify(`Permissions: ${mode === "yolo" ? "YOLO" : mode} for every agent of this session.`);
}
