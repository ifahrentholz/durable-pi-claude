// A pi-ai provider that answers with Claude Code through the official Claude Agent SDK (DPI_PROVIDER=claude-code).
//
// Why: Claude Code authenticates with your own `claude auth login`, so the agent runs on your Claude
// subscription. pi-durable stays the durable loop: every tool call is still a pi-durable task, shown and
// checkpointed exactly as with any other provider.
//
// How: one long-lived Claude Code process ("bridge") per pi conversation, keyed by the conversation's provider
// session id. Claude Code runs unmodified with its own system prompt (`preset: "claude_code"`); durable-pi's
// prompt sections are appended. Its built-in tools are disabled; the conversation's pi tools are offered through
// an in-process MCP server. When Claude calls one, the pi request ends with `toolUse`; pi-durable runs the tool
// as a durable task and sends the result with the next request, which resolves the waiting MCP call and lets
// Claude continue. If the transcripts ever diverge (restart, abort, fork, compaction, steering edge cases), the
// bridge is rebuilt from the pi transcript, which is the source of truth.
//
// What we never do: rewrite or disguise Claude Code's prompt, spoof headers, or use an API key. If Claude Code
// reports any credential other than the subscription login, requests fail.
import { createSdkMcpServer, query, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { calculateCost, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  TranscriptContext,
  Usage,
} from "@earendil-works/pi-ai";
import { randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { z } from "zod";

export const CLAUDE_CODE_PROVIDER = "claude-code";
const API = "claude-code";
const MCP_SERVER = "pi";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;
/** Bridges idle this long are closed; the next request rebuilds them from the transcript. */
const IDLE_MS = 30 * 60_000;
const DEBUG = !!process.env.DPI_CLAUDE_DEBUG;
const debug = (...args: unknown[]) => DEBUG && console.error("[claude-code]", ...args);

/** Subscription models offered in the picker; metadata (window, API-equivalent prices) from pi-ai's catalog. */
const MODEL_IDS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5"];
export const claudeCodeModels: Model<string>[] = anthropicProvider()
  .getModels()
  .filter((m) => MODEL_IDS.includes(m.id))
  .sort((a, b) => MODEL_IDS.indexOf(a.id) - MODEL_IDS.indexOf(b.id))
  .map((m) => ({ ...m, api: API, provider: CLAUDE_CODE_PROVIDER, baseUrl: "claude-code://local" }) as Model<string>);

export function installClaudeCode(models: MutableModels) {
  const stream = (model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions) =>
    respond(model, context, options);
  models.setProvider(
    createProvider({
      id: CLAUDE_CODE_PROVIDER,
      name: "Claude Code (subscription)",
      // Claude Code owns the credential (`claude auth login`); pi never sees one.
      auth: { apiKey: { name: "Claude Code login", resolve: async () => ({ auth: {} }) } },
      models: claudeCodeModels,
      api: { stream, streamSimple: stream },
    } as never),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------------------------------------------

const bridges = new Map<string, Bridge>();

function respond(model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: API,
    provider: CLAUDE_CODE_PROVIDER,
    model: model.id,
    responseId: `cc-${randomUUID()}`,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const run = async () => {
    out.push({ type: "start", partial: message });
    const { system, conversation } = split(context.messages);
    if (isCompletionOnly(system)) return completeOnce(model, system, conversation, options, out, message);

    const key = options?.sessionId ?? `adhoc-${randomUUID()}`;
    const fingerprint = hash(JSON.stringify(system));
    let bridge = bridges.get(key);
    let tail = bridge?.sync(conversation, fingerprint, model.id);
    if (!bridge || tail === undefined) {
      bridge?.close("rebuild");
      bridge = new Bridge(key, model, system, fingerprint, options);
      bridges.set(key, bridge);
      bridge.seed(conversation);
    } else {
      bridge.deliver(tail);
    }
    await bridge.pump(out, message, model, options?.signal);
  };
  run().catch((error) => {
    const key = options?.sessionId;
    if (key) bridges.get(key)?.close("error");
    const aborted = options?.signal?.aborted;
    message.stopReason = aborted ? "aborted" : "error";
    message.errorMessage = aborted ? "Request aborted" : String(error instanceof Error ? error.message : error);
    debug("request failed", message.errorMessage);
    out.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
    out.end(message);
  });
  return out;
}

/** Compaction and other single-shot completions: no tools, no session, Claude Code's prompt plus the request's. */
async function completeOnce(
  model: Model<string>,
  system: Message[],
  conversation: Message[],
  options: SimpleStreamOptions | undefined,
  out: AssistantMessageEventStream,
  message: AssistantMessage,
) {
  const prompt = conversation.map((m) => (m.role === "user" ? textOf(m.content) : "")).join("\n\n");
  const abortController = linkedAbort(options?.signal);
  let text = "";
  for await (const m of query({
    prompt,
    options: {
      ...baseOptions(model, options, abortController),
      tools: [],
      maxTurns: 1,
      systemPrompt: { type: "preset", preset: "claude_code", append: renderSystem(system) },
    },
  })) {
    checkAuth(m);
    if (m.type === "result") {
      if (m.subtype !== "success" || m.is_error) throw new Error(`Claude Code: ${m.subtype === "success" ? m.result : m.subtype}`);
      text = m.result;
      addUsage(message.usage, m.usage as never);
    }
  }
  message.content.push({ type: "text", text });
  out.push({ type: "text_start", contentIndex: 0, partial: message });
  out.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
  out.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
  finish(out, message, model, "stop");
}

// ---------------------------------------------------------------------------------------------------------------
// The bridge: one Claude Code process per pi conversation
// ---------------------------------------------------------------------------------------------------------------

type PendingCall = { id: string; name: string; args: unknown; resolve?: (r: CallResult) => void; result?: CallResult };
type CallResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };

class Bridge {
  private readonly input = new Queue<SDKUserMessage>();
  private readonly q: Query;
  private readonly iterator: AsyncIterator<SDKMessage>;
  private readonly abortController = new AbortController();
  /** Signatures of the pi transcript messages Claude Code already knows, in order. */
  private known: string[] = [];
  /** Tool calls announced in the current turn that pi has to answer. */
  private calls: PendingCall[] = [];
  private modelId: string;
  private idleTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(
    readonly key: string,
    model: Model<string>,
    system: Message[],
    readonly fingerprint: string,
    options: SimpleStreamOptions | undefined,
  ) {
    this.modelId = model.id;
    const tools = toolsOf(system);
    const server = createSdkMcpServer({
      name: MCP_SERVER,
      version: "1.0.0",
      alwaysLoad: true,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodShape(tool.parameters),
        handler: (args: unknown) => this.toolCalled(tool.name, args),
      })),
    } as never);
    this.q = query({
      prompt: this.input,
      options: {
        ...baseOptions(model, options, this.abortController),
        tools: [], // Claude Code's own tools off: every tool is a pi-durable tool, run and checkpointed by pi
        mcpServers: { [MCP_SERVER]: server },
        canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
        includePartialMessages: true,
        systemPrompt: { type: "preset", preset: "claude_code", append: renderSystem(system) },
      },
    });
    this.iterator = this.q[Symbol.asyncIterator]();
    debug(`bridge ${key}: ${tools.length} tools, model ${model.id}`);
  }

  /** The new tail of the transcript, or undefined when Claude Code's view diverged and the bridge must be rebuilt. */
  sync(conversation: Message[], fingerprint: string, modelId: string): Message[] | undefined {
    if (this.closed || fingerprint !== this.fingerprint) return undefined;
    const sigs = conversation.map(signature);
    if (sigs.length <= this.known.length || this.known.some((s, i) => sigs[i] !== s)) return undefined;
    const tail = conversation.slice(this.known.length);
    const waiting = this.calls.filter((c) => !c.result).map((c) => c.id);
    const results = tail.filter((m): m is ToolResultMessage => m.role === "toolResult");
    const others = tail.filter((m) => m.role !== "toolResult");
    if (others.some((m) => m.role !== "user")) return undefined;
    // Every waiting call needs its result, and no result may be for an unknown call.
    if (results.length !== waiting.length || results.some((r) => !waiting.includes(r.toolCallId))) return undefined;
    if (waiting.length === 0 && others.length === 0) return undefined;
    if (modelId !== this.modelId) {
      this.modelId = modelId;
      void this.q.setModel(modelId).catch(() => {});
    }
    this.known = sigs;
    return tail;
  }

  /** Feed the tail: tool results resolve the waiting MCP calls, user messages go to Claude Code's input. */
  deliver(tail: Message[]) {
    this.touch();
    const results = tail.filter((m): m is ToolResultMessage => m.role === "toolResult");
    const user = tail.filter((m) => m.role === "user").map((m) => textOf(m.content));
    // Steering: pi places a steer after the tool round. Claude Code is still inside that turn, waiting for the
    // results, so the message joins the last result instead of queueing behind the whole turn.
    if (results.length && user.length) {
      const last = results.at(-1)!;
      const steer = { type: "text" as const, text: `\n\n<user_message_while_you_worked>\n${user.join("\n\n")}\n</user_message_while_you_worked>` };
      results[results.length - 1] = { ...last, content: [...last.content, steer] };
    }
    for (const message of results) {
      const call = this.calls.find((c) => c.id === message.toolCallId);
      if (!call) continue;
      call.result = toCallResult(message);
      call.resolve?.(call.result);
    }
    if (!results.length && user.length) this.input.push(userMessage(user.join("\n\n")));
  }

  /** First request of a bridge: replay the pi transcript as context, then the pending work. */
  seed(conversation: Message[]) {
    this.touch();
    this.known = conversation.map(signature);
    const last = conversation.at(-1);
    const history = last?.role === "user" ? conversation.slice(0, -1) : conversation;
    const parts: string[] = [];
    if (history.length) {
      parts.push(
        "<conversation_history>\nThis conversation is restored from durable storage. Earlier turns, including the tool calls you made and their results:\n\n" +
          history.map(render).join("\n\n") +
          "\n</conversation_history>",
      );
    }
    if (last?.role === "user") parts.push(textOf(last.content));
    else parts.push("The previous response was interrupted after the tool results above. Continue the task from there.");
    this.input.push(userMessage(parts.join("\n\n")));
    debug(`bridge ${this.key}: seeded with ${history.length} earlier messages`);
  }

  /** Stream Claude Code's output into one pi response, until Claude calls pi tools or finishes the turn. */
  async pump(out: AssistantMessageEventStream, message: AssistantMessage, model: Model<string>, signal?: AbortSignal) {
    const onAbort = () => this.close("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    this.calls = this.calls.filter((c) => !c.result); // answered calls are done
    const blocks = new Map<number, { index: number; kind: "text" | "thinking" | "tool" | "internal"; json?: string }>();
    let piCalls: ToolCall[] = [];
    try {
      for (;;) {
        const next = await this.iterator.next();
        if (next.done) throw new Error("Claude Code ended the session");
        const m = next.value;
        checkAuth(m);
        if (m.type === "stream_event" && !m.parent_tool_use_id) {
          const e = m.event as StreamEvent;
          if (e.type === "message_start") {
            blocks.clear();
            addUsage(message.usage, e.message?.usage);
          } else if (e.type === "message_delta") {
            addUsage(message.usage, { output_tokens: e.usage?.output_tokens });
          } else if (e.type === "content_block_start") {
            const b = e.content_block;
            if (b.type === "text") {
              message.content.push({ type: "text", text: "" });
              blocks.set(e.index, { index: message.content.length - 1, kind: "text" });
              out.push({ type: "text_start", contentIndex: message.content.length - 1, partial: message });
            } else if (b.type === "thinking") {
              message.content.push({ type: "thinking", thinking: "" });
              blocks.set(e.index, { index: message.content.length - 1, kind: "thinking" });
              out.push({ type: "thinking_start", contentIndex: message.content.length - 1, partial: message });
            } else if (b.type === "tool_use" && b.name.startsWith(MCP_PREFIX)) {
              message.content.push({ type: "toolCall", id: b.id, name: b.name.slice(MCP_PREFIX.length), arguments: {} });
              blocks.set(e.index, { index: message.content.length - 1, kind: "tool", json: "" });
              out.push({ type: "toolcall_start", contentIndex: message.content.length - 1, partial: message });
            } else {
              blocks.set(e.index, { index: -1, kind: "internal" });
            }
          } else if (e.type === "content_block_delta") {
            const block = blocks.get(e.index);
            if (!block || block.kind === "internal") continue;
            const content = message.content[block.index]!;
            if (e.delta.type === "text_delta" && content.type === "text") {
              content.text += e.delta.text;
              out.push({ type: "text_delta", contentIndex: block.index, delta: e.delta.text, partial: message });
            } else if (e.delta.type === "thinking_delta" && content.type === "thinking") {
              content.thinking += e.delta.thinking;
              out.push({ type: "thinking_delta", contentIndex: block.index, delta: e.delta.thinking, partial: message });
            } else if (e.delta.type === "signature_delta" && content.type === "thinking") {
              content.thinkingSignature = (content.thinkingSignature ?? "") + e.delta.signature;
            } else if (e.delta.type === "input_json_delta" && content.type === "toolCall") {
              block.json += e.delta.partial_json;
              out.push({ type: "toolcall_delta", contentIndex: block.index, delta: e.delta.partial_json, partial: message });
            }
          } else if (e.type === "content_block_stop") {
            const block = blocks.get(e.index);
            if (!block || block.kind === "internal") continue;
            const content = message.content[block.index]!;
            if (content.type === "text") out.push({ type: "text_end", contentIndex: block.index, content: content.text, partial: message });
            else if (content.type === "thinking")
              out.push({ type: "thinking_end", contentIndex: block.index, content: content.thinking, partial: message });
            else if (content.type === "toolCall") {
              content.arguments = parseJson(block.json ?? "");
              this.announce(content.id, content.name, content.arguments);
              piCalls.push(content);
              out.push({ type: "toolcall_end", contentIndex: block.index, toolCall: content, partial: message });
            }
          } else if (e.type === "message_stop") {
            // One API response ended. With pi tool calls, hand them to pi-durable; Claude Code waits in the MCP calls.
            if (piCalls.length) {
              this.known.push(signature(message));
              return finish(out, message, model, "toolUse");
            }
          }
        } else if (m.type === "result") {
          if (m.subtype !== "success" || m.is_error) {
            const detail = m.subtype === "success" ? m.result : `${m.subtype}: ${("errors" in m ? m.errors : []).join("; ")}`;
            throw new Error(`Claude Code: ${detail}`);
          }
          piCalls = [];
          this.known.push(signature(message));
          return finish(out, message, model, "stop");
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.touch();
    }
  }

  /** A tool call announced in the stream; its MCP handler call waits for pi's result. */
  private announce(id: string, name: string, args: unknown) {
    this.calls.push({ id, name, args });
  }

  private toolCalled(name: string, args: unknown): Promise<CallResult> {
    // Match the MCP call to the announced tool_use block: same tool, same arguments, first unmatched.
    const sameArgs = JSON.stringify(args);
    const call =
      this.calls.find((c) => !c.resolve && c.name === name && JSON.stringify(c.args) === sameArgs) ??
      this.calls.find((c) => !c.resolve && c.name === name);
    if (!call) return Promise.resolve({ content: [{ type: "text", text: "Tool call could not be matched." }], isError: true });
    if (call.result) return Promise.resolve(call.result);
    return new Promise((resolve) => (call.resolve = resolve));
  }

  private touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close("idle"), IDLE_MS);
    this.idleTimer.unref();
  }

  close(reason: string) {
    if (this.closed) return;
    this.closed = true;
    debug(`bridge ${this.key} closed (${reason})`);
    clearTimeout(this.idleTimer);
    for (const call of this.calls) call.resolve?.({ content: [{ type: "text", text: "Interrupted." }], isError: true });
    this.input.end();
    this.abortController.abort();
    try {
      this.q.close();
    } catch {}
    if (bridges.get(this.key) === this) bridges.delete(this.key);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

type StreamEvent =
  | { type: "message_start"; message?: { usage?: AnthropicUsage } }
  | { type: "message_delta"; usage?: { output_tokens?: number } }
  | { type: "message_stop" }
  | { type: "content_block_start"; index: number; content_block: { type: string; id: string; name: string } }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "signature_delta"; signature: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number };
type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

const EFFORT: Record<string, "low" | "medium" | "high" | "xhigh" | "max"> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

function baseOptions(model: Model<string>, options: SimpleStreamOptions | undefined, abortController: AbortController) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: "durable-pi-claude/0.1.0",
    MCP_TOOL_TIMEOUT: String(24 * 3600_000), // pi tools (bash, jobs) may run long
  };
  // Never let Claude Code bill an API key: the subscription login is the point.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return {
    model: model.id,
    cwd: tmpdir(), // Claude Code's own cwd only; pi tools run in the conversation's folder
    env,
    abortController,
    persistSession: false,
    settingSources: [], // isolation: no local settings; durable-pi supplies tools and instructions
    // Only the pi MCP server: no claude.ai connectors or local MCP servers that would run outside pi-durable.
    strictMcpConfig: true,
    settings: { disableClaudeAiConnectors: true },
    ...(options?.reasoning ? { effort: EFFORT[options.reasoning] ?? "medium" } : { thinking: { type: "disabled" as const } }),
  };
}

function checkAuth(m: SDKMessage) {
  if (m.type === "system" && m.subtype === "init") {
    debug(`init: Claude Code ${m.claude_code_version}, model ${m.model}, auth ${m.apiKeySource}, tools ${m.tools.length}`);
    if (DEBUG) debug("tools:", m.tools.filter((t) => !t.startsWith(MCP_PREFIX)).join(",") || "(only pi tools)");
    if (m.apiKeySource !== "none")
      throw new Error(`Claude Code would bill via "${m.apiKeySource}", not your subscription login. Run \`claude auth login\`.`);
  }
}

function finish(out: AssistantMessageEventStream, message: AssistantMessage, model: Model<string>, reason: "stop" | "toolUse") {
  message.stopReason = reason;
  message.usage.totalTokens = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
  message.usage.cost = calculateCost(model as never, message.usage);
  out.push({ type: "done", reason, message });
  out.end(message);
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function addUsage(usage: Usage, u?: AnthropicUsage) {
  if (!u) return;
  usage.input += u.input_tokens ?? 0;
  usage.output += u.output_tokens ?? 0;
  usage.cacheRead += u.cache_read_input_tokens ?? 0;
  usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
}

function split(messages: Message[]) {
  return {
    system: messages.filter((m) => m.role === "system"),
    conversation: messages.filter((m) => m.role !== "system"),
  };
}

/** pi-durable's compaction request: a system prompt with content, no tool declarations. */
function isCompletionOnly(system: Message[]) {
  return system.every((m) => m.role === "system" && !m.toolsAdded?.length) && system.some((m) => m.role === "system" && textOf(m.content).trim());
}

/** The prompt pi-durable built for this conversation: base text plus named sections, latest version of each. */
function renderSystem(system: Message[]): string {
  const sections = new Map<string, string>();
  const base: string[] = [];
  for (const m of system) {
    if (m.role !== "system") continue;
    const text = textOf(m.content).trim();
    if (text) base.push(text);
    for (const [name, value] of Object.entries(m.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  return [...base, ...sections.values()].join("\n\n");
}

function toolsOf(system: Message[]): Tool[] {
  const tools = new Map<string, Tool>();
  for (const m of system) {
    if (m.role !== "system") continue;
    for (const removed of m.toolsRemoved ?? []) tools.delete(removed.name);
    for (const added of m.toolsAdded ?? []) tools.set(added.name, added);
  }
  return [...tools.values()];
}

function zodShape(schema: unknown): Record<string, z.ZodType> {
  try {
    const parsed = z.fromJSONSchema(JSON.parse(JSON.stringify(schema)) as never) as unknown as { shape?: Record<string, z.ZodType> };
    if (parsed.shape) return parsed.shape;
  } catch (error) {
    debug("schema conversion failed", error);
  }
  return {};
}

function signature(m: Message): string {
  if (m.role === "user") return `u:${hash(textOf(m.content))}`;
  if (m.role === "toolResult") return `t:${m.toolCallId}`;
  if (m.role === "assistant")
    return `a:${hash(m.content.map((c) => (c.type === "text" ? c.text.trim() : c.type === "toolCall" ? `#${c.id}` : "")).join("|"))}`;
  return `s:${hash(JSON.stringify(m))}`;
}

function render(m: Message): string {
  if (m.role === "user") return `[user]\n${textOf(m.content)}`;
  if (m.role === "toolResult") return `[tool result: ${m.toolName}${m.isError ? ", error" : ""}]\n${truncate(textOf(m.content), 4000)}`;
  if (m.role === "assistant") {
    return m.content
      .map((c) =>
        c.type === "text" ? `[assistant]\n${c.text}` : c.type === "toolCall" ? `[assistant called ${c.name}] ${truncate(JSON.stringify(c.arguments), 2000)}` : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function toCallResult(m: ToolResultMessage): CallResult {
  const content = m.content.map((c) =>
    c.type === "text" ? { type: "text" as const, text: c.text } : { type: "image" as const, data: c.data, mimeType: c.mimeType },
  );
  return { content: content.length ? content : [{ type: "text", text: "(no output)" }], isError: m.isError };
}

function userMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as (TextContent | ThinkingContent | { type: string })[])
    .map((c) => (c.type === "text" ? (c as TextContent).text : c.type === "image" ? "[image]" : ""))
    .join("");
}

function parseJson(text: string): Record<string, never> {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text;
}

function hash(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function linkedAbort(signal?: AbortSignal) {
  const controller = new AbortController();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

/** A push-based async iterable: Claude Code's streaming input. */
class Queue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private ended = false;
  push(item: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }
  end() {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
