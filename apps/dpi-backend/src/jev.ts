// Decision-model client (TypeSafe System One format), from harness/extensions/jev-bash/core/client.ts: one call
// answers a few bounded questions about a JSON state in a few hundred milliseconds.
//
// This fork makes the judge pluggable, so it can run on your machine:
//
//   DPI_JUDGE=systemone   any System One server: a local Kev (https://github.com/jaredpalmer/kev) or Laya.
//                         DPI_JUDGE_URL (default http://127.0.0.1:8009), DPI_JUDGE_API_KEY, DPI_JUDGE_MODEL.
//   DPI_JUDGE=ollama      a local Ollama model, asked one question at a time with single-letter options; the
//                         probabilities come from the answer token's log-probabilities (not calibrated like Kev/Jev).
//                         DPI_JUDGE_MODEL (default qwen3:4b-instruct), OLLAMA_HOST (default http://127.0.0.1:11434).
//   (unset)               Jev in the cloud through TYPESAFE_API_KEY or OPENROUTER_API_KEY, as upstream.
export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };
export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };

const RETRY = new Set([429, 502, 503, 529]);

type Judge =
  | { kind: "systemone"; endpoint: string; key?: string; model: string; label: string }
  | { kind: "ollama"; host: string; model: string; label: string };

/** The configured judge, or undefined when none is (the caller then uses offline rules). */
export function judge(env = process.env): Judge | undefined {
  if (env.DPI_JUDGE === "ollama") {
    const model = env.DPI_JUDGE_MODEL || "qwen3:4b-instruct";
    return { kind: "ollama", host: (env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, ""), model, label: `Ollama ${model}` };
  }
  if (env.DPI_JUDGE === "systemone") {
    const base = (env.DPI_JUDGE_URL || "http://127.0.0.1:8009").replace(/\/$/, "");
    return {
      kind: "systemone",
      endpoint: base.endsWith("/v1/systemone") ? base : `${base}/v1/systemone`,
      ...(env.DPI_JUDGE_API_KEY ? { key: env.DPI_JUDGE_API_KEY } : {}),
      model: env.DPI_JUDGE_MODEL || "jev-latest",
      label: `local decision model at ${base}`,
    };
  }
  if (env.TYPESAFE_API_KEY)
    return { kind: "systemone", endpoint: "https://api.typesafe.ai/v1/systemone", key: env.TYPESAFE_API_KEY, model: "jev-latest", label: "Jev (TypeSafe)" };
  if (env.OPENROUTER_API_KEY)
    return { kind: "systemone", endpoint: "https://openrouter.ai/api/alpha/decisions", key: env.OPENROUTER_API_KEY, model: "~typesafe/jev-latest", label: "Jev (OpenRouter)" };
  return undefined;
}

export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  signal?: AbortSignal,
): Promise<Record<string, JevAnswer>> {
  const j = judge();
  if (!j) throw Error("No judge configured: set DPI_JUDGE (systemone | ollama), TYPESAFE_API_KEY or OPENROUTER_API_KEY");
  return j.kind === "ollama" ? askOllama(j, state, questions, signal) : askSystemOne(j, state, questions, signal);
}

async function askSystemOne(
  j: Extract<Judge, { kind: "systemone" }>,
  state: unknown,
  questions: Record<string, JevQuestion>,
  signal?: AbortSignal,
) {
  const body = JSON.stringify({ model: j.model, state, questions });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(j.endpoint, {
      method: "POST",
      headers: { ...(j.key ? { Authorization: `Bearer ${j.key}` } : {}), "Content-Type": "application/json" },
      body,
      signal: timeout(signal),
      redirect: "error",
    });
    if (RETRY.has(res.status) && attempt < 3) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw Error(`Judge HTTP ${res.status}`);
    const data = (await res.json()) as { answers?: Record<string, JevAnswer> };
    for (const [id, q] of Object.entries(questions))
      if (data.answers?.[id]?.type !== q.type) throw Error(`Judge answer missing: ${id}`);
    return data.answers!;
  }
}

/** One question per request, options as letters, probabilities from the first answer token. */
async function askOllama(
  j: Extract<Judge, { kind: "ollama" }>,
  state: unknown,
  questions: Record<string, JevQuestion>,
  signal?: AbortSignal,
) {
  const answers: Record<string, JevAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const options =
      q.type === "choice"
        ? Object.entries(q.criteria)
        : [
            ["yes", q.criteria?.true ?? "yes"],
            ["no", q.criteria?.false ?? "no"],
          ];
    const letters = options.map((_, i) => String.fromCharCode(65 + i));
    const prompt = [
      `<state>\n${JSON.stringify(state, null, 2)}\n</state>`,
      `Question: ${q.instructions}`,
      options.map(([name, why], i) => `${letters[i]}) ${name}: ${why}`).join("\n"),
      "Answer with the single letter of the best option.",
    ].join("\n\n");
    const res = await fetch(`${j.host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: j.model,
        stream: false,
        think: false,
        logprobs: true,
        top_logprobs: 10,
        keep_alive: "30m",
        options: { temperature: 0, num_predict: 1 },
        messages: [
          { role: "system", content: "You are a careful decision model. Reply with exactly one letter." },
          { role: "user", content: prompt },
        ],
      }),
      signal: timeout(signal),
    });
    if (!res.ok) throw Error(`Ollama HTTP ${res.status}`);
    const data = (await res.json()) as { logprobs?: { top_logprobs?: { token: string; logprob: number }[] }[] };
    const top = data.logprobs?.[0]?.top_logprobs ?? [];
    const mass = letters.map((l) => top.filter((t) => t.token.trim().replace(/[).:]/g, "") === l).reduce((s, t) => s + Math.exp(t.logprob), 0));
    const total = mass.reduce((a, b) => a + b, 0);
    if (!(total > 0)) throw Error(`Ollama gave no option letter for ${id}`);
    const probabilities = Object.fromEntries(options.map(([name], i) => [name, mass[i] / total]));
    if (q.type === "noul") answers[id] = { type: "noul", noul: probabilities.yes };
    else {
      const [choice, confidence] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
      answers[id] = { type: "choice", choice, confidence, probabilities };
    }
  }
  return answers;
}

function timeout(signal?: AbortSignal) {
  // A local model may need to load first; the cloud answers in a few hundred milliseconds.
  const ms = judge()?.kind === "ollama" || process.env.DPI_JUDGE === "systemone" ? 60_000 : 15_000;
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}
