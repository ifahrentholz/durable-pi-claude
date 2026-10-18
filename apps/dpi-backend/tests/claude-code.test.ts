// The claude-code bridge against a scripted fake Claude Code: no network, no subscription.
// The fake behaves like the real one where it matters: it calls MCP tools one after another and independently of
// how fast the bridge reads the stream, it may call a tool before the bridge has read its tool_use block, and it
// takes user messages that arrive during a turn.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import type { AssistantMessage, Message, TranscriptContext } from "@earendil-works/pi-ai";
import { claudeCodeModels, installClaudeCode, setClaudeSdkForTests, CLAUDE_CODE_PROVIDER } from "../src/claude-code.js";

type Handler = (args: unknown) => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;
type Helpers = {
  emit: (message: unknown) => void;
  text: (text: string) => void;
  toolUse: (calls: { id: string; name: string; args: object }[], opts?: { callEarly?: string }) => void;
  call: (name: string, args: object) => Promise<string>;
  takeQueued: () => string[];
  result: (text: string) => void;
  log: string[];
};
type Script = (input: string, h: Helpers) => Promise<void>;

class Channel<T> {
  private items: T[] = [];
  private waiters: ((v: T) => void)[] = [];
  push(v: T) {
    const w = this.waiters.shift();
    if (w) w(v);
    else this.items.push(v);
  }
  next(): Promise<T> {
    return this.items.length ? Promise.resolve(this.items.shift()!) : new Promise((r) => this.waiters.push(r));
  }
  drain() {
    return this.items.splice(0);
  }
}

const END = Symbol("end");
const ev = (event: object) => ({ type: "stream_event", parent_tool_use_id: null, event });

function fakeClaude(script: Script) {
  const state = { tools: new Map<string, Handler>(), queries: [] as { options: Record<string, unknown> }[], log: [] as string[], apiKeySource: "none" };
  const fake = {
    createSdkMcpServer: ((opts: { tools: { name: string; handler: Handler }[] }) => {
      for (const t of opts.tools) state.tools.set(t.name, t.handler);
      return { type: "sdk", name: "pi", instance: {} };
    }) as never,
    query: (({ prompt, options }: { prompt: string | AsyncIterable<{ message: { content: string } }>; options: Record<string, unknown> }) => {
      state.queries.push({ options });
      const out = new Channel<unknown>();
      const inputs = new Channel<string>();
      const h: Helpers = {
        emit: (m) => out.push(m),
        log: state.log,
        text: (text) => {
          out.push(ev({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 100 } } }));
          out.push(ev({ type: "content_block_start", index: 0, content_block: { type: "text" } }));
          out.push(ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
          out.push(ev({ type: "content_block_stop", index: 0 }));
          out.push(ev({ type: "message_delta", usage: { output_tokens: 5 } }));
          out.push(ev({ type: "message_stop" }));
        },
        toolUse: (calls, opts) => {
          out.push(ev({ type: "message_start", message: { usage: { input_tokens: 10 } } }));
          calls.forEach((c, i) => {
            out.push(ev({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: c.id, name: `mcp__pi__${c.name}` } }));
            out.push(ev({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.args) } }));
            // Real Claude Code may start a tool before the bridge has read its tool_use block.
            if (opts?.callEarly === c.id) void h.call(c.name, c.args);
            out.push(ev({ type: "content_block_stop", index: i }));
          });
          out.push(ev({ type: "message_delta", usage: { output_tokens: 7 } }));
          out.push(ev({ type: "message_stop" }));
        },
        call: async (name, args) => {
          state.log.push(`call:${name}:${JSON.stringify(args)}`);
          const r = await state.tools.get(name)!(args);
          const text = r.content.map((c) => c.text ?? "").join("");
          state.log.push(`result:${text}${r.isError ? " (error)" : ""}`);
          return text;
        },
        takeQueued: () => inputs.drain(),
        result: (text) => out.push({ type: "result", subtype: "success", is_error: false, result: text, usage: {} }),
      };
      out.push({ type: "system", subtype: "init", apiKeySource: state.apiKeySource, claude_code_version: "fake", model: options.model, tools: [] });
      void (async () => {
        if (typeof prompt === "string") {
          await script(prompt, h);
          return out.push(END);
        }
        // Like the SDK, read the input stream continuously, also while a turn runs.
        void (async () => {
          for await (const m of prompt) {
            state.log.push(`input:${m.message.content.slice(0, 40)}`);
            inputs.push(m.message.content);
          }
        })();
        for (;;) await script(await inputs.next(), h);
      })();
      const iterator = {
        next: async () => {
          const value = await out.next();
          return value === END ? { value: undefined, done: true } : { value, done: false };
        },
        return: async () => ({ value: undefined, done: true }),
      };
      return {
        [Symbol.asyncIterator]: () => iterator,
        setModel: async (m: string) => void state.log.push(`setModel:${m}`),
        close: () => void state.log.push("close"),
        interrupt: async () => {},
      };
    }) as never,
  };
  setClaudeSdkForTests(fake);
  return state;
}

afterEach(() => setClaudeSdkForTests(undefined));

const BASH = { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };
const SYSTEM: Message = { role: "system", content: "", sections: { rules: "<rules>be durable</rules>" }, toolsAdded: [BASH as never], timestamp: 0 };
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const toolResult = (id: string, text: string): Message =>
  ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 0 }) as Message;

function provider() {
  const models = createModels();
  installClaudeCode(models);
  const p = models.getProvider(CLAUDE_CODE_PROVIDER)!;
  const model = claudeCodeModels.find((m) => m.id === "claude-haiku-4-5")!;
  return (messages: Message[], opts: { sessionId?: string; modelId?: string } = {}) =>
    p
      .streamSimple({ ...model, id: opts.modelId ?? model.id } as never, { messages } as unknown as TranscriptContext, {
        sessionId: opts.sessionId ?? "s1",
      })
      .result() as Promise<AssistantMessage>;
}
const textOf = (m: AssistantMessage) => m.content.map((c) => (c.type === "text" ? c.text : "")).join("");

test("tool loop: a pi tool call ends the response with toolUse; its result continues the same Claude Code turn", async () => {
  const cc = fakeClaude(async (input, h) => {
    h.toolUse([{ id: "t1", name: "bash", args: { command: "echo hi" } }]);
    const out = await h.call("bash", { command: "echo hi" });
    h.text(`got ${out}`);
    h.result(`got ${out}`);
  });
  const ask = provider();
  const first = await ask([SYSTEM, user("run it")]);
  assert.equal(first.stopReason, "toolUse");
  assert.deepEqual(first.content.filter((c) => c.type === "toolCall").map((c) => c.type === "toolCall" && [c.id, c.name, c.arguments]), [["t1", "bash", { command: "echo hi" }]]);
  assert.ok(first.usage.input > 0 && first.usage.cost.total > 0, "usage and API-equivalent cost are reported");
  const second = await ask([SYSTEM, user("run it"), first, toolResult("t1", "hi")]);
  assert.equal(second.stopReason, "stop");
  assert.equal(textOf(second), "got hi");
  assert.equal(cc.queries.length, 1, "one Claude Code process for the conversation");
  const opts = cc.queries[0].options as { tools: unknown[]; strictMcpConfig: boolean; systemPrompt: { preset: string; append: string }; env: Record<string, string> };
  assert.deepEqual(opts.tools, [], "Claude Code's own tools are off");
  assert.equal(opts.strictMcpConfig, true);
  assert.equal(opts.systemPrompt.preset, "claude_code", "Claude Code keeps its own system prompt");
  assert.match(opts.systemPrompt.append, /be durable/, "durable-pi's sections are appended");
  assert.equal(opts.env.ANTHROPIC_API_KEY, undefined, "never bills an API key");
});

test("parallel calls: results wait for Claude Code's sequential MCP calls, also one that came early", async () => {
  const cc = fakeClaude(async (_input, h) => {
    h.toolUse(
      [
        { id: "a", name: "bash", args: { command: "echo a" } },
        { id: "b", name: "bash", args: { command: "echo b" } },
        { id: "c", name: "bash", args: { command: "echo c" } },
      ],
      { callEarly: "a" },
    );
    const b = await h.call("bash", { command: "echo b" });
    const c = await h.call("bash", { command: "echo c" });
    h.text(`${b},${c}`);
    h.result("done");
  });
  const ask = provider();
  const first = await ask([SYSTEM, user("three at once")]);
  assert.equal(first.content.filter((c) => c.type === "toolCall").length, 3);
  const second = await ask([SYSTEM, user("three at once"), first, toolResult("a", "A"), toolResult("b", "B"), toolResult("c", "C")]);
  assert.equal(textOf(second), "B,C");
  assert.ok(cc.log.includes("result:A"), "the early call got its own result");
  assert.ok(!cc.log.some((l) => l.includes("could not be matched")));
});

test("steering: the user's message reaches Claude Code as a user message before the tool round's results", async () => {
  const cc = fakeClaude(async (_input, h) => {
    h.toolUse([{ id: "t1", name: "bash", args: { command: "sleep 10" } }]);
    await h.call("bash", { command: "sleep 10" });
    const steer = h.takeQueued();
    h.text(steer.length ? `handled: ${steer.join(" ")}` : "no steer");
    h.result("ok");
  });
  const ask = provider();
  const first = await ask([SYSTEM, user("long task")]);
  const second = await ask([SYSTEM, user("long task"), first, toolResult("t1", ""), user("also say hello")]);
  assert.equal(textOf(second), "handled: also say hello");
  const input = cc.log.findIndex((l) => l === "input:also say hello");
  const result = cc.log.findIndex((l) => l.startsWith("result:"));
  assert.ok(input >= 0 && input < result, `steer queued before the result was released: ${cc.log.join(" | ")}`);
  assert.ok(!cc.log.some((l) => l.startsWith("result:") && l.includes("also say hello")), "never embedded in a tool result");
});

test("rebuild: a transcript Claude Code does not know is replayed as history; model changes apply live", async () => {
  const seen: string[] = [];
  const cc = fakeClaude(async (input, h) => {
    seen.push(input);
    h.text("ok");
    h.result("ok");
  });
  const ask = provider();
  const history = [SYSTEM, user("remember PELICAN"), { role: "assistant", content: [{ type: "text", text: "noted" }], api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: 0 } as never as Message];
  const first = await ask([...history, user("what was it?")]);
  assert.match(seen[0], /<conversation_history>[\s\S]*remember PELICAN[\s\S]*noted[\s\S]*<\/conversation_history>[\s\S]*what was it\?$/);
  await ask([...history, user("what was it?"), first, user("and now?")], { modelId: "claude-sonnet-5-5" });
  assert.ok(cc.log.includes("setModel:claude-sonnet-5-5"));
  assert.equal(cc.queries.length, 1);
  // A diverged transcript (e.g. after a compaction or an edit elsewhere) rebuilds the process.
  await ask([SYSTEM, user("something else entirely")]);
  assert.equal(cc.queries.length, 2);
  assert.ok(cc.log.includes("close"));
});

test("subscription only: any credential other than the Claude login fails the request", async () => {
  const cc = fakeClaude(async (_input, h) => {
    h.text("should not get here");
    h.result("x");
  });
  cc.apiKeySource = "ANTHROPIC_API_KEY";
  const reply = await provider()([SYSTEM, user("hi")], { sessionId: "s-auth" });
  assert.equal(reply.stopReason, "error");
  assert.match(reply.errorMessage ?? "", /not your subscription login/);
});

test("compaction: a request without tools is one Claude Code completion without tools", async () => {
  const cc = fakeClaude(async (input, h) => {
    h.result(`summary of: ${input.slice(0, 20)}`);
  });
  const system: Message = { role: "system", content: "You are a context summarization assistant.", timestamp: 0 };
  const reply = await provider()([system, user("conversation to summarize")], { sessionId: "s-compact" });
  assert.equal(reply.stopReason, "stop");
  assert.equal(textOf(reply), "summary of: conversation to summ");
  const opts = cc.queries[0].options as { tools: unknown[]; maxTurns: number; systemPrompt: { append: string } };
  assert.deepEqual(opts.tools, []);
  assert.equal(opts.maxTurns, 1);
  assert.match(opts.systemPrompt.append, /summarization assistant/);
});
