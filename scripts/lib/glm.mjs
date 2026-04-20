import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { suggestAlternatives } from "./models.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";
import { appendLogBlock, appendLogLine } from "./tracked-jobs.mjs";

const PLUGIN_LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(PLUGIN_LIB_DIR, "..", "..", "schemas");
const REVIEW_SCHEMA_PATH = path.join(SCHEMAS_DIR, "review-output.schema.json");

export async function getGlmAvailability() {
  const check = binaryAvailable("zai", ["--version"]);
  if (!check.available) {
    return { available: false, detail: "zai CLI not found in PATH." };
  }
  const version = check.detail || "unknown";
  return { available: true, version, detail: "GLM CLI available." };
}

export async function getGlmLoginStatus() {
  // Check for ZAI_API_KEY env var
  if (process.env.ZAI_API_KEY) {
    return { loggedIn: true, detail: "Auth configured via ZAI_API_KEY." };
  }

  // Check for ~/.zai/user-settings.json
  const settingsPath = path.join(os.homedir(), ".zai", "user-settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (settings.apiKey) {
        return { loggedIn: true, detail: "Auth configured via ~/.zai/user-settings.json." };
      }
    } catch {
      // Fall through
    }
  }

  return { loggedIn: false, detail: "No ZAI_API_KEY set and no ~/.zai/user-settings.json found." };
}

/**
 * Run a task via zai CLI in headless mode.
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} options.prompt
 * @param {string} [options.model]
 * @param {string} [options.logFile]
 * @param {Function} [options.onProgress]
 * @param {number} [options.timeoutMs=300000]
 * @returns {Promise<{output: string, exitStatus: number}>}
 */
export async function runTask(options = {}) {
  const {
    cwd = process.cwd(),
    prompt,
    model,
    logFile,
    onProgress,
    timeoutMs = 300_000,
  } = options;

  const args = ["--prompt", prompt];
  if (model) {
    args.push("--model", model);
  }

  onProgress?.({ message: "Starting GLM task...", phase: "starting" });
  appendLogLine(logFile, `Running: zai ${args.map((a) => a.length > 80 ? `"${a.slice(0, 77)}..."` : `"${a}"`).join(" ")}`);

  const result = runCommand("zai", args, { cwd, timeoutMs });

  if (result.error?.code === "ETIMEDOUT") {
    const modelLabel = model ?? "default";
    const structured = new Error(`GLM task timed out after ${Math.round(timeoutMs / 1000)}s.`);
    structured.code = "CLI_ERROR";
    structured.model = modelLabel;
    structured.suggestions = [`Increase timeout`, `Try a faster model`];
    throw structured;
  }

  if (result.error?.code === "ENOENT") {
    throw new Error("zai CLI not found. Install it with: npm install -g @guizmo-ai/zai-cli");
  }

  const output = result.stdout.trim();
  const stderr = result.stderr.trim();

  appendLogBlock(logFile, "Task output", output);
  if (stderr) {
    appendLogLine(logFile, `stderr: ${stderr}`);
  }

  // Check for rate limiting
  if (result.status !== 0) {
    const combinedOutput = `${stderr}\n${output}`;
    const isRateLimit = /429|rate.limit|quota|RESOURCE_EXHAUSTED/i.test(combinedOutput);
    if (isRateLimit) {
      const modelLabel = model ?? "default";
      const structured = new Error(`Model "${modelLabel}" hit rate limits.`);
      structured.code = "RATE_LIMITED";
      structured.model = modelLabel;
      structured.suggestions = suggestAlternatives(model);
      throw structured;
    }
  }

  onProgress?.({ message: "Task completed.", phase: "done" });

  return {
    output,
    exitStatus: result.status,
  };
}

/**
 * Run a code review via zai CLI.
 * Builds a review prompt from git context, sends via runTask, validates response.
 */
export async function runReview(options = {}) {
  const {
    cwd = process.cwd(),
    reviewContext,
    systemPrompt,
    focusText,
    model,
    logFile,
    onProgress,
    timeoutMs = 600_000,
  } = options;

  const reviewPrompt = buildReviewPrompt(reviewContext, systemPrompt, focusText);

  const { output, exitStatus } = await runTask({
    cwd,
    prompt: reviewPrompt,
    model,
    logFile,
    onProgress,
    timeoutMs,
  });

  appendLogBlock(logFile, "Review output", output);
  const reviewResult = parseReviewOutput(output);
  return { reviewResult, exitStatus };
}

function buildReviewPrompt(reviewContext, systemPrompt, focusText) {
  const parts = [];
  if (systemPrompt) parts.push(systemPrompt);
  if (reviewContext?.content) {
    parts.push(`\n\nRepository context to review:\n${reviewContext.content}`);
  }
  if (focusText) {
    parts.push(`\n\nAdditional focus: ${focusText}`);
  }
  parts.push(
    `\n\nRespond with ONLY valid JSON matching this schema — no prose, no markdown fences:\n{"verdict":"no-issues"|"needs-attention"|"no-ship","summary":"...","findings":[{"severity":"critical|high|medium|low","title":"...","body":"...","file":"...","line_start":N,"recommendation":"..."}],"next_steps":["..."]}`,
  );
  return parts.join("");
}

export function parseReviewOutput(raw) {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    const e = new Error(`Review output is not valid JSON: ${err.message}`);
    e.code = "REVIEW_PARSE_ERROR";
    e.raw = raw;
    throw e;
  }

  const schema = JSON.parse(fs.readFileSync(REVIEW_SCHEMA_PATH, "utf8"));
  const validationError = validateAgainstSchema(parsed, schema);
  if (validationError) {
    const e = new Error(`Review output failed validation: ${validationError}`);
    e.code = "REVIEW_VALIDATION_ERROR";
    e.parsed = parsed;
    throw e;
  }

  return normalizeReviewResult(parsed);
}

function validateAgainstSchema(data, schema) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  for (const field of schema.required ?? []) {
    if (!(field in data)) return `Missing required field: "${field}"`;
  }
  const verdictEnum = schema.properties?.verdict?.enum;
  if (verdictEnum && !verdictEnum.includes(data.verdict)) {
    return `Invalid verdict "${data.verdict}". Expected one of: ${verdictEnum.join(", ")}`;
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return '"summary" must be a non-empty string.';
  }
  if (!Array.isArray(data.findings)) return '"findings" must be an array.';
  if (!Array.isArray(data.next_steps)) return '"next_steps" must be an array.';
  return null;
}

function normalizeReviewResult(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((f, i) => ({
      severity: typeof f.severity === "string" ? f.severity : "low",
      title: typeof f.title === "string" && f.title.trim() ? f.title.trim() : `Finding ${i + 1}`,
      body: typeof f.body === "string" ? f.body.trim() : "",
      file: typeof f.file === "string" ? f.file.trim() : "unknown",
      line_start: Number.isInteger(f.line_start) && f.line_start > 0 ? f.line_start : null,
      line_end: Number.isInteger(f.line_end) && f.line_end > 0 ? f.line_end : null,
      recommendation: typeof f.recommendation === "string" ? f.recommendation.trim() : "",
    })),
    next_steps: data.next_steps.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()),
  };
}
