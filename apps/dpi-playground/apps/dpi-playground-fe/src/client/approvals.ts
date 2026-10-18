// Tool approvals in the web client (this fork): the agent's `demo.approvals` document, the decision actions,
// and the session's rules that skip the question.
import { computed, ref } from "vue";
import { APPROVALS_DOC, type ApprovalDecision, type ApprovalItem, type ApprovalsDoc } from "@sdk/approvals";
import { agentHandle, agentState, attempt, notify } from "./store";

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

export async function loadRules(): Promise<string[] | undefined> {
  return (await attempt(() => agentHandle.value!.demo<{ allow: string[] }>("approval-rules", undefined, "GET")))?.allow;
}

export async function editRules(change: { add?: string; remove?: string }): Promise<string[] | undefined> {
  return (await attempt(() => agentHandle.value!.demo<{ allow: string[] }>("approval-rules", change)))?.allow;
}
