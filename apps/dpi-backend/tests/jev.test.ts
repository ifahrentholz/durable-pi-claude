// Pluggable judge (this fork): System One servers (Kev, Laya, Jev) and Ollama, against fake local servers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { askJev, judge, type JevQuestion } from "../src/jev.js";

const QUESTIONS: Record<string, JevQuestion> = {
  effect: { type: "choice", instructions: "What does `command` do?", criteria: { read_only: "reads", reversible: "edits", irreversible: "deletes" } },
  destructive: { type: "noul", instructions: "Does it wipe something?", criteria: { true: "rm -rf", false: "ls" } },
};

async function fake(handler: (body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => unknown) {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const out = await handler(JSON.parse(raw || "{}"), req, res);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

function withEnv(env: Record<string, string | undefined>) {
  const keys = ["DPI_JUDGE", "DPI_JUDGE_URL", "DPI_JUDGE_MODEL", "DPI_JUDGE_API_KEY", "OLLAMA_HOST", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

test("judge: picks the configured backend", () => {
  const restore = withEnv({});
  try {
    assert.equal(judge(), undefined);
    assert.equal(judge({ OPENROUTER_API_KEY: "k" })?.label, "Jev (OpenRouter)");
    const kev = judge({ DPI_JUDGE: "systemone" });
    assert.ok(kev?.kind === "systemone" && kev.endpoint === "http://127.0.0.1:8009/v1/systemone");
    assert.equal(judge({ DPI_JUDGE: "ollama" })?.label, "Ollama qwen3:4b-instruct");
  } finally {
    restore();
  }
});

test("judge: a System One server (Kev, Laya) gets Jev's request and its key", async () => {
  let seen: { body: Record<string, unknown>; auth?: string } | undefined;
  const server = await fake((body, req) => {
    seen = { body, auth: req.headers.authorization };
    return {
      answers: {
        effect: { type: "choice", choice: "irreversible", confidence: 0.9, probabilities: { read_only: 0.05, reversible: 0.05, irreversible: 0.9 } },
        destructive: { type: "noul", noul: 0.97 },
      },
    };
  });
  const restore = withEnv({ DPI_JUDGE: "systemone", DPI_JUDGE_URL: server.url, DPI_JUDGE_API_KEY: "secret" });
  try {
    const a = await askJev({ command: "rm -rf /" }, QUESTIONS);
    assert.deepEqual(seen?.body, { model: "jev-latest", state: { command: "rm -rf /" }, questions: QUESTIONS });
    assert.equal(seen?.auth, "Bearer secret");
    assert.equal(a.effect.type === "choice" && a.effect.choice, "irreversible");
    assert.equal(a.destructive.type === "noul" && a.destructive.noul, 0.97);
  } finally {
    restore();
    server.close();
  }
});

test("judge: Ollama answers one letter per question; probabilities come from its log-probabilities", async () => {
  const prompts: string[] = [];
  const server = await fake((body) => {
    const user = (body.messages as { role: string; content: string }[]).find((m) => m.role === "user")!.content;
    prompts.push(user);
    // effect: C (irreversible) most likely; destructive: A (yes) most likely.
    const top = user.includes("C) irreversible")
      ? [{ token: "C", logprob: Math.log(0.8) }, { token: "B", logprob: Math.log(0.15) }, { token: "A", logprob: Math.log(0.05) }]
      : [{ token: "A", logprob: Math.log(0.9) }, { token: " B", logprob: Math.log(0.1) }];
    return { message: { content: top[0].token }, logprobs: [{ token: top[0].token, logprob: top[0].logprob, top_logprobs: top }] };
  });
  const restore = withEnv({ DPI_JUDGE: "ollama", OLLAMA_HOST: server.url, DPI_JUDGE_MODEL: "tiny" });
  try {
    const a = await askJev({ command: "rm -rf build" }, QUESTIONS);
    assert.equal(prompts.length, 2, "one request per question");
    assert.match(prompts[1], /A\) yes: rm -rf\nB\) no: ls/);
    assert.ok(a.effect.type === "choice" && a.effect.choice === "irreversible" && Math.abs(a.effect.confidence - 0.8) < 1e-9);
    assert.ok(a.destructive.type === "noul" && Math.abs(a.destructive.noul - 0.9) < 1e-9);
  } finally {
    restore();
    server.close();
  }
});
