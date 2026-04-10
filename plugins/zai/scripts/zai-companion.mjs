#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { getZaiAvailability, getZaiLoginStatus, runReview, runTask } from "./lib/zai.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { buildSingleJobSnapshot, buildStatusSnapshot, readStoredJob, resolveCancelableJob, resolveResultJob } from "./lib/job-control.mjs";
import { DEFAULT_REVIEW_MODEL, resolveModel } from "./lib/models.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import { renderCancelReport, renderJobStatusReport, renderSetupReport, renderStatusReport, renderStoredJobResult } from "./lib/render.mjs";
import { generateJobId, getConfig, setConfig, upsertJob, writeJobFile } from "./lib/state.mjs";
import { appendLogLine, createJobLogFile, createJobProgressUpdater, createJobRecord, createProgressReporter, nowIso, runTrackedJob } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/zai-companion.mjs setup [--json] [--enable-review-gate|--disable-review-gate]",
    "  node scripts/zai-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
    "  node scripts/zai-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
    "  node scripts/zai-companion.mjs task [--background] [--write] [--model <model>] [prompt]",
    "  node scripts/zai-companion.mjs status [job-id] [--all] [--json]",
    "  node scripts/zai-companion.mjs result [job-id] [--json]",
    "  node scripts/zai-companion.mjs cancel [job-id] [--json]",
  ].join("\n"));
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw?.trim()) return [];
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: { C: "cwd", ...(config.aliasMap ?? {}) },
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "").split(/\r?\n/).map((v) => v.trim()).find(Boolean);
  return line ?? fallback;
}

// --- Setup ---

async function buildSetupReport(cwd) {
  const nodeAvailable = binaryAvailable("node");
  const zai = await getZaiAvailability();
  const auth = await getZaiLoginStatus();
  const ready = zai.available && auth.loggedIn;
  const config = getConfig(resolveWorkspaceRoot(cwd));

  const nextSteps = [];
  if (!zai.available) {
    nextSteps.push("Install the ZAI CLI: npm install -g @guizmo-ai/zai-cli");
  }
  if (zai.available && !auth.loggedIn) {
    nextSteps.push("Configure auth: set ZAI_API_KEY or run `zai config` to set your API key.");
  }

  return {
    ready,
    node: { detail: nodeAvailable ? "available" : "NOT FOUND" },
    zai,
    auth,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken: [],
    nextSteps,
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
  }

  const report = await buildSetupReport(cwd);
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

// --- Readiness guard ---

async function ensureZaiReady() {
  const zai = await getZaiAvailability();
  if (!zai.available) {
    throw new Error("ZAI CLI is not installed. Install it with: npm install -g @guizmo-ai/zai-cli");
  }
  const auth = await getZaiLoginStatus();
  if (!auth.loggedIn) {
    throw new Error("ZAI CLI is not authenticated. Set ZAI_API_KEY or run `zai config`.");
  }
}

// --- Job infrastructure ---

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") return "adversarial-review";
  return jobClass === "review" ? "review" : "task";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id),
    }),
  };
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, { logFile: options.logFile, stderr: !options.json });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "zai-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = { ...job, status: "queued", phase: "queued", pid: child.pid ?? null, logFile, request };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: { jobId: job.id, status: "queued", title: job.title, summary: job.summary, logFile },
    logFile,
  };
}

// --- Task ---

async function executeTaskRun(request) {
  const result = await runTask({
    cwd: request.cwd,
    prompt: request.prompt,
    model: request.model,
    onProgress: request.onProgress,
  });

  const rawOutput = result.output ?? "";
  const payload = { status: result.exitStatus, rawOutput };

  return {
    exitStatus: result.exitStatus,
    payload,
    rendered: rawOutput ? `${rawOutput}\n` : "Task completed.\n",
    summary: firstMeaningfulLine(rawOutput, "Task finished."),
    jobTitle: request.jobTitle ?? "ZAI Task",
    jobClass: "task",
    write: Boolean(request.write),
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "background"],
    aliasMap: { m: "model" },
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = resolveModel(options.model);
  const prompt = readTaskPrompt(cwd, options, positionals);
  const write = Boolean(options.write);

  if (!prompt) throw new Error("Provide a prompt, a prompt file, or piped stdin.");

  const title = "ZAI Task";
  const summary = shorten(prompt || "Task");

  if (options.background) {
    await ensureZaiReady();
    const job = createCompanionJob({ prefix: "task", kind: "task", title, workspaceRoot, jobClass: "task", summary, write });
    const request = { cwd, model, prompt, write, jobId: job.id };
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, `${title} started in the background as ${payload.jobId}. Check /zai:status ${payload.jobId} for progress.\n`, options.json);
    return;
  }

  const job = createCompanionJob({ prefix: "task", kind: "task", title, workspaceRoot, jobClass: "task", summary, write });
  await runForegroundCommand(job, (progress) => executeTaskRun({ cwd, model, prompt, write, jobId: job.id, onProgress: progress, jobTitle: title }), { json: options.json });
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd", "job-id"] });
  if (!options["job-id"]) throw new Error("Missing required --job-id for task-worker.");

  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) throw new Error(`No stored job found for ${options["job-id"]}.`);

  const request = storedJob.request;
  if (!request || typeof request !== "object") throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);

  const { logFile, progress } = createTrackedProgress({ ...storedJob, workspaceRoot }, { logFile: storedJob.logFile ?? null });
  await runTrackedJob({ ...storedJob, workspaceRoot, logFile }, () => executeTaskRun({ ...request, onProgress: progress }), { logFile });
}

// --- Review ---

async function executeReviewRun(request) {
  await ensureZaiReady();
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, { base: request.base, scope: request.scope });
  const context = collectReviewContext(request.cwd, target);
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";

  let systemPrompt = null;
  if (reviewName === "Adversarial Review") {
    const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
    systemPrompt = interpolateTemplate(template, {
      TARGET_LABEL: target.label,
      USER_FOCUS: focusText || "No extra focus provided.",
      REVIEW_INPUT: context.content,
    });
  }

  const model = request.model ?? DEFAULT_REVIEW_MODEL;
  const { reviewResult, exitStatus } = await runReview({
    cwd: request.cwd,
    reviewContext: context,
    model,
    focusText,
    systemPrompt: systemPrompt ?? undefined,
    logFile: request.logFile,
    onProgress: request.onProgress,
  });

  const lines = [`Verdict: ${reviewResult.verdict}`, `Summary: ${reviewResult.summary}`];
  if (reviewResult.findings?.length > 0) {
    lines.push(`Findings: ${reviewResult.findings.length}`);
    for (const finding of reviewResult.findings) {
      lines.push(`  [${finding.severity}] ${finding.title}`);
    }
  }
  if (reviewResult.next_steps?.length > 0) {
    lines.push("Next steps:");
    for (const step of reviewResult.next_steps) lines.push(`  - ${step}`);
  }

  return {
    exitStatus,
    payload: { review: reviewName, target, reviewResult },
    rendered: `${lines.join("\n")}\n`,
    summary: reviewResult.summary ?? `${reviewName} finished.`,
    jobTitle: `ZAI ${reviewName}`,
    jobClass: "review",
    targetLabel: target.label,
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { m: "model" },
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const kind = config.reviewName === "Adversarial Review" ? "adversarial-review" : "review";
  const title = `ZAI ${config.reviewName}`;
  const summary = `${config.reviewName} ${target.label}`;

  const job = createCompanionJob({ prefix: "review", kind, title, workspaceRoot, jobClass: "review", summary });

  await runForegroundCommand(job, (progress) => executeReviewRun({
    cwd,
    base: options.base,
    scope: options.scope,
    model: resolveModel(options.model, DEFAULT_REVIEW_MODEL),
    focusText,
    reviewName: config.reviewName,
    onProgress: progress,
  }), { json: options.json });
}

async function handleReview(argv) {
  return handleReviewCommand(argv, { reviewName: "Review" });
}

// --- Status ---

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"],
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";

  if (reference) {
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

// --- Result ---

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  outputCommandResult({ job, storedJob }, renderStoredJobResult(job, storedJob), options.json);
}

// --- Cancel ---

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference);

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = { ...job, status: "cancelled", phase: "cancelled", pid: null, completedAt, errorMessage: "Cancelled by user." };

  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  writeJobFile(workspaceRoot, job.id, { ...existing, ...nextJob, cancelledAt: completedAt });
  upsertJob(workspaceRoot, { id: job.id, status: "cancelled", phase: "cancelled", pid: null, errorMessage: "Cancelled by user.", completedAt });

  outputCommandResult({ jobId: job.id, status: "cancelled", title: job.title }, renderCancelReport(nextJob), options.json);
}

// --- Main ---

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup": await handleSetup(argv); break;
    case "review": await handleReview(argv); break;
    case "adversarial-review": await handleReviewCommand(argv, { reviewName: "Adversarial Review" }); break;
    case "task": await handleTask(argv); break;
    case "task-worker": await handleTaskWorker(argv); break;
    case "status": await handleStatus(argv); break;
    case "result": handleResult(argv); break;
    case "cancel": await handleCancel(argv); break;
    default: throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().then(
  () => { process.exit(process.exitCode ?? 0); },
  (error) => {
    if (error?.code === "RATE_LIMITED" || error?.code === "MODEL_UNAVAILABLE" || error?.code === "CLI_ERROR") {
      const lines = [`# ZAI Error`, ``, `Model: ${error.model ?? "unknown"}`, `Status: ${error.code}`, ``, error.message];
      if (error.suggestions?.length > 0) {
        lines.push(``, `Try instead:`);
        for (const s of error.suggestions) lines.push(`- --model ${s}`);
      }
      process.stderr.write(`${lines.join("\n")}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(1);
  },
);
