// Minimal Jev client: TypeSafe System One directly, or through OpenRouter's decisions endpoint.
// This fork: DPI_JUDGE=systemone asks a local System One server instead, e.g. Kev (https://github.com/jaredpalmer/kev)
// on DPI_JUDGE_URL (default http://127.0.0.1:8009). It needs a server that answers score questions too.
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
};
export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };
export type JevResult = {
  model: string;
  answers: Record<string, ChoiceAnswer | ScoreAnswer>;
  cost: number | null;
  latencyMs: number;
};

const RETRY = new Set([429, 502, 503, 529]);

export class Jev {
  readonly provider: string;
  private readonly endpoint: string;
  private readonly key: string;
  private readonly model: string;

  constructor() {
    if (process.env.DPI_JUDGE === "systemone") {
      const base = (process.env.DPI_JUDGE_URL || "http://127.0.0.1:8009").replace(/\/$/, "");
      this.provider = /\/\/(127\.0\.0\.1|localhost)[:/]/.test(base) ? "kev (local)" : base;
      this.endpoint = base.endsWith("/v1/systemone") ? base : `${base}/v1/systemone`;
      this.key = process.env.DPI_JUDGE_API_KEY ?? "";
      this.model = process.env.DPI_JUDGE_MODEL || "jev-latest";
    } else if (process.env.DPI_JUDGE === "ollama") {
      throw Error("The proactive demo needs a System One judge that also answers score questions: DPI_JUDGE=systemone with a local Kev (`just judge kev`)");
    } else if (process.env.TYPESAFE_API_KEY) {
      this.provider = "typesafe";
      this.endpoint = "https://api.typesafe.ai/v1/systemone";
      this.key = process.env.TYPESAFE_API_KEY;
      this.model = "jev-latest";
    } else if (process.env.OPENROUTER_API_KEY) {
      this.provider = "openrouter";
      this.endpoint = "https://openrouter.ai/api/alpha/decisions";
      this.key = process.env.OPENROUTER_API_KEY;
      this.model = "~typesafe/jev-latest";
    } else
      throw Error(
        "No judge: set DPI_JUDGE=systemone and run a local Kev (`just judge kev`, or `duracel`), or set TYPESAFE_API_KEY or OPENROUTER_API_KEY",
      );
  }

  async ask(state: unknown, questions: Record<string, Question>): Promise<JevResult> {
    const started = performance.now();
    const body = JSON.stringify({ model: this.model, state, questions });
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}), "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      if (RETRY.has(res.status) && attempt < 3) {
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw Error(`Judge HTTP ${res.status}`);
      const data = (await res.json()) as {
        model: string;
        answers: JevResult["answers"];
        usage?: { cost?: unknown };
      };
      for (const [id, question] of Object.entries(questions))
        if (data.answers?.[id]?.type !== question.type) throw Error(`Jev answer missing: ${id}`);
      const cost = data.usage?.cost;
      return {
        model: data.model,
        answers: data.answers,
        cost: typeof cost === "number" && cost >= 0 ? cost : null,
        latencyMs: Math.round(performance.now() - started),
      };
    }
  }
}
