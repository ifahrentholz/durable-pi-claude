import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { projectEnvPath } from "../../../shared/paths.ts";

// OPENROUTER_API_KEY and ELEVENLABS_API_KEY live in the project root .env.
if (existsSync(projectEnvPath)) process.loadEnvFile(projectEnvPath);
// This fork: the device settings `just net up local` wrote (provider and judge), so the demo runs like the device.
// Only these keys, and never over a value that is already set.
const deviceEnv = process.env.DPI_ENV_FILE ?? join(process.env.DPI_HOME ?? join(homedir(), ".dpi"), "backend.env");
if (existsSync(deviceEnv)) {
  const values = parseEnv(readFileSync(deviceEnv, "utf8"));
  for (const key of ["DPI_PROVIDER", "DPI_JUDGE", "DPI_JUDGE_URL", "DPI_JUDGE_API_KEY", "DPI_JUDGE_MODEL"])
    if (process.env[key] === undefined && values[key] !== undefined) process.env[key] = values[key];
}

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => {
  const i = args.indexOf(key);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw Error(`${key} needs a value`);
  return args[i + 1];
};
// Host playback uses afplay, which only macOS has. Elsewhere the voice plays in the browser.
const tts = option("--tts", process.platform === "darwin" ? "host" : "browser");
if (!["host", "browser", "both", "off"].includes(tts)) throw Error("--tts is host, browser, both, or off");

/** claude-code (this fork: Claude Code on your Claude subscription) or openrouter (upstream). */
const provider = option(
  "--provider",
  process.env.DPI_PROVIDER === "claude-code" || (!process.env.DPI_PROVIDER && !process.env.OPENROUTER_API_KEY)
    ? "claude-code"
    : "openrouter",
);
if (!["claude-code", "openrouter"].includes(provider)) throw Error("--provider is claude-code or openrouter");

export const config = {
  provider: provider as "claude-code" | "openrouter",
  port: Number(option("--port", "4790")),
  /** Loopback by default: the UI has no login and the incident agent runs bash. Pass --host 0.0.0.0 for a LAN. */
  host: option("--host", "127.0.0.1"),
  dev: args.includes("--dev"),
  model: option("--model", provider === "claude-code" ? "claude-sonnet-5-5" : "anthropic/claude-sonnet-5.5"),
  thinking: option("--thinking", "high") as "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
  /** Incident verdicts sharing one fingerprint inside the window that open an incident. */
  incidentThreshold: Number(option("--incident-threshold", "3")),
  /** Suspicious verdicts sharing one fingerprint inside the window that open an incident. */
  suspiciousThreshold: Number(option("--suspicious-threshold", "8")),
  windowMs: Number(option("--window", "120")) * 1000,
  /** A local judge answers one request at a time, so more parallel requests only wait longer (this fork: 2). */
  jevConcurrency: Number(
    option(
      "--jev-concurrency",
      process.env.DPI_JUDGE === "systemone" && /\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.DPI_JUDGE_URL || "http://127.0.0.1:8009") ? "2" : "6",
    ),
  ),
  /** Rows older than this when first seen are marked skipped instead of judged. */
  backlogMs: Number(option("--backlog", "300")) * 1000,
  tts: tts as "host" | "browser" | "both" | "off",
  /** Also speak when an incident opens. Off by default: the demo has one voice line, at ready for review. */
  announceOpen: args.includes("--announce-open"),
  voiceId: process.env.ELEVENLABS_VOICE_ID ?? "56bWURjYFHyYyVf490Dp",
  voiceModel: process.env.ELEVENLABS_MODEL ?? "eleven_v4_turbo",
  /** Without an ElevenLabs key, macOS `say` speaks (this fork). DPI_SAY_VOICE picks a voice from `say -v '?'`. */
  sayVoice: process.env.DPI_SAY_VOICE ?? "Samantha",
  openedSpeech:
    process.env.DPI_OPENED_SPEECH ??
    "Engineer, heads up. Jev flagged a production issue in {service}. A durable agent is investigating.",
  readySpeech:
    process.env.DPI_READY_SPEECH ??
    "Engineer, your Durable Agent Red Team found a production issue, and found the fix. It's waiting on your review.",
};
