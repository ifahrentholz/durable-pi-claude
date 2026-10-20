import type { Lane, Merge, Ticket } from "../../jira-flow-be/src/types.ts";
export type { Lane, Merge, Ticket };

export type Model = {
  id: string;
  provider: string;
  name: string;
  tier: string;
  icon: string;
  contextWindow: number;
};
export type Config = {
  models: Model[];
  defaultModel?: Model;
  rootConversationId: number;
  judge: string;
  pollIntervalSec: number;
  label: string;
  maxConcurrent: number;
  approvalMode: "both" | "gitlab-only" | "jira-only";
  autoMerge: boolean;
  maxReviewRounds: number;
  reviewQuick: boolean;
  projects: string[];
  version: string;
};
export type Stats = {
  total: number;
  ready: number;
  needsClarification: number;
  inProgress: number;
  waiting: number;
  done: number;
  blocked: number;
};

export type Block = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
};
export type Message = {
  role: string;
  toolCallId?: string;
  content: string | Block[];
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
};
export type Entry = {
  id: number;
  kind: string;
  model?: Message[];
  data?: { text?: string };
};
export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
};
export type Live = {
  run?: { taskId: number };
  generation?: { message?: Message; retry?: { at: number; error: string }; attempt: number };
  tools?: { callId: string; name: string; status: string; output?: string }[];
};
export type ChatSnapshot = {
  conversationId: number;
  view: {
    entries: Entry[];
    docs: {
      "pi.agent"?: { model?: { provider: string; modelId: string }; thinkingLevel?: string };
      "pi.live"?: Live;
      "pi.inbox"?: { items: { id: number; mode: string; content?: unknown }[] };
      "pi.usage"?: { models: Record<string, Usage> };
    };
  };
  tickets: Ticket[];
  merges: Merge[];
  tools: string[];
  serverTime: number;
};
