# ZAI Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a full Claude Code plugin that wraps the `zai` CLI (`@guizmo-ai/zai-cli`) to delegate code reviews, tasks, and rescue work to GLM models (Z.ai / Zhipu AI).

**Architecture:** Plugin follows the gemini-plugin-cc pattern — a Node.js companion script (`zai-companion.mjs`) is the single entry point. Commands are Markdown files that tell Claude Code how to invoke the companion. The companion spawns `zai` in headless mode (`zai --prompt "..."`) and streams stdout. Job tracking persists state to `${CLAUDE_PLUGIN_DATA}/state/`. Hooks handle session lifecycle and an optional stop-gate review.

**Tech Stack:** Node.js (ESM, no dependencies), Claude Code plugin SDK (Markdown commands/agents/skills/hooks)

---

## File Map

### Plugin metadata
- Create: `plugins/zai/.claude-plugin/plugin.json`

### Library modules (`plugins/zai/scripts/lib/`)
- Create: `args.mjs` — CLI argument parsing (shared by all commands)
- Create: `fs.mjs` — File utilities (temp dirs, text detection, JSON read/write)
- Create: `process.mjs` — Process spawning, `binaryAvailable()`, `terminateProcessTree()`
- Create: `workspace.mjs` — Workspace root detection via git
- Create: `git.mjs` — Git operations (repo root, branch, diff, review target resolution, context collection)
- Create: `models.mjs` — Model name constants, aliases, resolution, alternatives
- Create: `prompts.mjs` — Prompt template loading and interpolation
- Create: `state.mjs` — Job state persistence (load/save/upsert/config)
- Create: `tracked-jobs.mjs` — Job lifecycle (create record, progress tracking, run tracked job)
- Create: `job-control.mjs` — Job display, filtering, status snapshots
- Create: `render.mjs` — Output formatting (setup report, review result, status, cancel)
- Create: `zai.mjs` — ZAI CLI wrappers (availability, auth, runTask, runReview, killJob)

### Main scripts (`plugins/zai/scripts/`)
- Create: `zai-companion.mjs` — Main entry point with subcommand routing
- Create: `session-lifecycle-hook.mjs` — SessionStart/SessionEnd handler
- Create: `stop-review-gate-hook.mjs` — Optional stop-gate review

### Schemas (`plugins/zai/schemas/`)
- Create: `review-output.schema.json`
- Create: `error-output.schema.json`

### Prompts (`plugins/zai/prompts/`)
- Create: `adversarial-review.md`
- Create: `stop-review-gate.md`

### Commands (`plugins/zai/commands/`)
- Create: `setup.md`, `review.md`, `adversarial-review.md`, `task.md`, `rescue.md`, `status.md`, `result.md`, `cancel.md`

### Agent (`plugins/zai/agents/`)
- Create: `zai-rescue.md`

### Skills (`plugins/zai/skills/`)
- Create: `zai-cli-runtime/SKILL.md`
- Create: `zai-prompting/SKILL.md`
- Create: `zai-prompting/references/glm-prompt-antipatterns.md`
- Create: `zai-prompting/references/glm-prompt-recipes.md`
- Create: `zai-result-handling/SKILL.md`

### Hooks (`plugins/zai/hooks/`)
- Create: `hooks.json`

---

### Task 1: Plugin Scaffold + Metadata

**Files:**
- Create: `plugins/zai/.claude-plugin/plugin.json`

- [ ] **Step 1: Create plugin.json**

```json
{
  "name": "zai",
  "version": "1.0.0",
  "description": "Use ZAI CLI (GLM) from Claude Code to review code or delegate tasks.",
  "author": {
    "name": "corploc"
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/zai/.claude-plugin/plugin.json
git commit -m "feat: scaffold zai plugin with metadata"
```

---

### Task 2: Core Library — args.mjs

**Files:**
- Create: `plugins/zai/scripts/lib/args.mjs`

- [ ] **Step 1: Write args.mjs**

Adapted from gemini plugin. Two exports: `parseArgs(argv, config)` and `splitRawArgumentString(raw)`.

```js
export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] =
          inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/zai/scripts/lib/args.mjs
git commit -m "feat(zai): add CLI argument parsing module"
```

---

### Task 3: Core Library — fs.mjs, process.mjs, workspace.mjs

**Files:**
- Create: `plugins/zai/scripts/lib/fs.mjs`
- Create: `plugins/zai/scripts/lib/process.mjs`
- Create: `plugins/zai/scripts/lib/workspace.mjs`

- [ ] **Step 1: Write fs.mjs**

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "zai-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return fs.readFileSync(0, "utf8");
}
```

- [ ] **Step 2: Write process.mjs**

```js
import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    stdio: options.stdio ?? "pipe",
    timeout: options.timeoutMs,
    shell: process.platform === "win32",
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && result.error.code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return {
    available: true,
    detail: result.stdout.trim() || result.stderr.trim() || "ok",
  };
}

export function terminateProcessTree(pid) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false };
  }

  try {
    process.kill(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        process.kill(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }
    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
```

- [ ] **Step 3: Write workspace.mjs**

```js
import { ensureGitRepository } from "./git.mjs";

export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add plugins/zai/scripts/lib/fs.mjs plugins/zai/scripts/lib/process.mjs plugins/zai/scripts/lib/workspace.mjs
git commit -m "feat(zai): add fs, process, and workspace utility modules"
```

---

### Task 4: Core Library — git.mjs

**Files:**
- Create: `plugins/zai/scripts/lib/git.mjs`

- [ ] **Step 1: Write git.mjs**

Full git module with review target resolution and context collection. Adapted from gemini plugin — identical logic, no ACP dependencies.

```js
import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) return candidate;
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) return `origin/${candidate}`;
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return { mode: "branch", label: `branch diff against ${baseRef}`, baseRef, explicit: true };
  }

  if (requestedScope === "working-tree") {
    return { mode: "working-tree", label: "working tree diff", explicit: true };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(`Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`);
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return { mode: "branch", label: `branch diff against ${detectedBase}`, baseRef: detectedBase, explicit: true };
  }

  if (state.isDirty) {
    return { mode: "working-tree", label: "working tree diff", explicit: false };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return { mode: "branch", label: `branch diff against ${detectedBase}`, baseRef: detectedBase, explicit: false };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  const stat = fs.statSync(absolutePath);
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  const buffer = fs.readFileSync(absolutePath);
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state) {
  const status = gitChecked(cwd, ["status", "--short"]).stdout.trim();
  const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
  const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
  const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");

  const parts = [
    formatSection("Git Status", status),
    formatSection("Staged Diff", stagedDiff),
    formatSection("Unstaged Diff", unstagedDiff),
    formatSection("Untracked Files", untrackedBody),
  ];

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
  };
}

function collectBranchContext(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  const commitRange = `${mergeBase}..HEAD`;
  const currentBranch = getCurrentBranch(cwd);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", commitRange]).stdout.trim();
  const diff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", commitRange]).stdout;

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${mergeBase}.`,
    content: [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection("Branch Diff", diff),
    ].join("\n"),
  };
}

export function collectReviewContext(cwd, target) {
  const repoRoot = getRepoRoot(cwd);
  const state = getWorkingTreeState(cwd);
  const currentBranch = getCurrentBranch(cwd);
  let details;

  if (target.mode === "working-tree") {
    details = collectWorkingTreeContext(repoRoot, state);
  } else {
    details = collectBranchContext(repoRoot, target.baseRef);
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    ...details,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/zai/scripts/lib/git.mjs
git commit -m "feat(zai): add git operations module"
```

---

### Task 5: Core Library — models.mjs, prompts.mjs

**Files:**
- Create: `plugins/zai/scripts/lib/models.mjs`
- Create: `plugins/zai/scripts/lib/prompts.mjs`

- [ ] **Step 1: Write models.mjs**

GLM model constants, aliases, and resolution.

```js
export const MODELS = Object.freeze({
  GLM_5_1: "glm-5.1",
  GLM_5: "glm-5",
  GLM_4_7: "glm-4.7",
  GLM_4_7_FLASH: "glm-4.7-flash",
  GLM_4_5_FLASH: "glm-4.5-flash",
});

export const DEFAULT_MODEL = MODELS.GLM_5_1;
export const DEFAULT_REVIEW_MODEL = MODELS.GLM_4_7;
export const DEFAULT_GATE_MODEL = MODELS.GLM_4_7_FLASH;

export const MODEL_ALIASES = new Map([
  ["flagship", MODELS.GLM_5_1],
  ["thinking", MODELS.GLM_4_7],
  ["flash", MODELS.GLM_4_7_FLASH],
  ["free", MODELS.GLM_4_5_FLASH],
]);

export function resolveModel(input, fallback = DEFAULT_MODEL) {
  if (input == null) return fallback;
  const normalized = String(input).trim();
  if (!normalized) return fallback;
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

export function suggestAlternatives(failedModelId) {
  const alternatives = [];
  for (const [alias, modelId] of MODEL_ALIASES) {
    if (modelId !== failedModelId) {
      alternatives.push(alias);
    }
  }
  if (alternatives.length === 0) {
    return [...MODEL_ALIASES.keys()];
  }
  return alternatives;
}
```

- [ ] **Step 2: Write prompts.mjs**

```js
import fs from "node:fs";
import path from "node:path";

export function loadPromptTemplate(rootDir, name) {
  const promptPath = path.join(rootDir, "prompts", `${name}.md`);
  return fs.readFileSync(promptPath, "utf8");
}

export function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    return Object.hasOwn(variables, key) ? variables[key] : "";
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add plugins/zai/scripts/lib/models.mjs plugins/zai/scripts/lib/prompts.mjs
git commit -m "feat(zai): add model resolution and prompt template modules"
```

---

### Task 6: Core Library — state.mjs, tracked-jobs.mjs

**Files:**
- Create: `plugins/zai/scripts/lib/state.mjs`
- Create: `plugins/zai/scripts/lib/tracked-jobs.mjs`

- [ ] **Step 1: Write state.mjs**

Job state persistence. Identical pattern to gemini plugin but with `zai-companion` naming.

```js
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "zai-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: { stopReviewGate: false },
    jobs: [],
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: { ...defaultState().config, ...(parsed.config ?? {}) },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: { ...defaultState().config, ...(state.config ?? {}) },
    jobs: nextJobs,
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) continue;
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({ createdAt: timestamp, updatedAt: timestamp, ...jobPatch });
      return;
    }
    state.jobs[existingIndex] = { ...state.jobs[existingIndex], ...jobPatch, updatedAt: timestamp };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = { ...state.config, [key]: value };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
```

- [ ] **Step 2: Write tracked-jobs.mjs**

Job lifecycle management — create records, track progress, run tracked jobs. Adapted from gemini plugin with `ZAI_COMPANION_SESSION_ID`.

```js
import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "ZAI_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
    };
  }
  return { message: String(value ?? "").trim(), phase: null };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) return;
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) return;
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {}),
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    if (!normalized.phase || normalized.phase === lastPhase) return;

    lastPhase = normalized.phase;
    const patch = { id: jobId, phase: normalized.phase };
    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) return;

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, { ...storedJob, ...patch });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) return null;

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    if (stderr && event.message) {
      process.stderr.write(`[zai] ${event.message}\n`);
    }
    appendLogLine(logFile, event.message);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) return null;
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null,
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered,
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt,
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null,
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt,
    });
    throw error;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add plugins/zai/scripts/lib/state.mjs plugins/zai/scripts/lib/tracked-jobs.mjs
git commit -m "feat(zai): add state persistence and job tracking modules"
```

---

### Task 7: Core Library — job-control.mjs, render.mjs

**Files:**
- Create: `plugins/zai/scripts/lib/job-control.mjs`
- Create: `plugins/zai/scripts/lib/render.mjs`

- [ ] **Step 1: Write job-control.mjs**

Job display, filtering, status snapshots. Adapted from gemini plugin — replace all `gemini` references with `zai`.

```js
import fs from "node:fs";

import { getConfig, listJobs, readJobFile, resolveJobFile } from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")),
  );
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) return jobs;
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) return job.kindLabel;
  if (job.kind === "adversarial-review") return "adversarial-review";
  if (job.jobClass === "review") return "review";
  if (job.jobClass === "task") return "rescue";
  if (job.kind === "review") return "review";
  if (job.kind === "task") return "rescue";
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) return [];

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && line !== "Final output");

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) return null;

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) return null;

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null,
  };

  return { ...enriched, phase: enriched.phase ?? "unknown" };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) return null;
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) return filtered[0] ?? null;

  const exact = filtered.find((job) => job.id === reference);
  if (exact) return exact;

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /zai:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  const oldestJob = [...jobs].sort((left, right) =>
    String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")),
  )[0] ?? null;
  const sessionRuntimeLabel = formatElapsedDuration(oldestJob?.createdAt ?? null) ?? "unknown";

  return {
    workspaceRoot,
    config,
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate),
    sessionRuntime: { label: sessionRuntimeLabel },
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /zai:status to inspect known jobs.`);
  }

  return { workspaceRoot, job: enrichJob(selected, { maxProgressLines: options.maxProgressLines }) };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(
    reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)),
  );
  const selected = matchJobReference(jobs, reference, (job) =>
    job.status === "completed" || job.status === "failed" || job.status === "cancelled",
  );

  if (selected) return { workspaceRoot, job: selected };

  const active = matchJobReference(jobs, reference, (job) =>
    job.status === "queued" || job.status === "running",
  );
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /zai:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /zai:status to inspect active jobs.`);
  }

  throw new Error("No finished ZAI jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) throw new Error(`No active job found for "${reference}".`);
    return { workspaceRoot, job: selected };
  }

  if (activeJobs.length === 1) return { workspaceRoot, job: activeJobs[0] };
  if (activeJobs.length > 1) {
    throw new Error("Multiple ZAI jobs are active. Pass a job id to /zai:cancel.");
  }

  throw new Error("No active ZAI jobs to cancel.");
}
```

- [ ] **Step 2: Write render.mjs**

Output formatting for all command results. All "Gemini" references become "ZAI", all `/gemini:` become `/zai:`.

```js
function severityRank(severity) {
  switch (severity) {
    case "critical": return 0;
    case "high": return 1;
    case "medium": return 2;
    default: return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) return "";
  if (!finding.line_end || finding.line_end === finding.line_start) return `:${finding.line_start}`;
  return `:${finding.line_start}-${finding.line_end}`;
}

function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "Expected a top-level JSON object.";
  if (typeof data.verdict !== "string" || !data.verdict.trim()) return "Missing string `verdict`.";
  if (typeof data.summary !== "string" || !data.summary.trim()) return "Missing string `summary`.";
  if (!Array.isArray(data.findings)) return "Missing array `findings`.";
  if (!Array.isArray(data.next_steps)) return "Missing array `next_steps`.";
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd = Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart) ? source.line_end : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : "",
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps.filter((step) => typeof step === "string" && step.trim()).map((step) => step.trim()),
  };
}

function escapeMarkdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) parts.push(job.kindLabel);
  if (job.title) parts.push(job.title);
  return parts.join(" | ");
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) lines.push(`  Summary: ${job.summary}`);
  if (job.phase) lines.push(`  Phase: ${job.phase}`);
  if (options.showElapsed && job.elapsed) lines.push(`  Elapsed: ${job.elapsed}`);
  if (options.showDuration && job.duration) lines.push(`  Duration: ${job.duration}`);
  if (job.logFile && options.showLog) lines.push(`  Log: ${job.logFile}`);
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /zai:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /zai:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /zai:review --wait");
    lines.push("  Stricter review: /zai:adversarial-review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# ZAI Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- zai: ${report.zai.detail}`,
    `- auth: ${report.auth.detail}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    "",
  ];

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) lines.push(`- ${action}`);
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) lines.push(`- ${step}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(reviewResult, meta) {
  const validationError = validateReviewResultShape(reviewResult);
  if (validationError) {
    return `# ZAI ${meta.reviewLabel}\n\nTarget: ${meta.targetLabel}\nValidation error: ${validationError}\n`;
  }

  const data = normalizeReviewResultData(reviewResult);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# ZAI ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    "",
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) lines.push(`  Recommendation: ${finding.recommendation}`);
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) lines.push(`- ${step}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
  const message = String(parsedResult?.failureMessage ?? "").trim() || "ZAI did not return a final message.";
  return `${message}\n`;
}

export function renderStatusReport(report) {
  const lines = [
    "# ZAI Status",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`,
    "",
  ];

  if (report.running.length > 0) {
    lines.push("Active jobs:");
    lines.push("| Job | Kind | Status | Phase | Elapsed | Summary | Actions |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const job of report.running) {
      const actions = [`/zai:status ${job.id}`];
      if (job.status === "queued" || job.status === "running") actions.push(`/zai:cancel ${job.id}`);
      lines.push(`| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((a) => `\`${a}\``).join("<br>")} |`);
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, { showDuration: true, showLog: report.latestFinished.status === "failed" });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, { showDuration: true, showLog: job.status === "failed" });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    lines.push("Ending the session will trigger a fresh ZAI adversarial review and block if it finds issues.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# ZAI Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true,
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) || "";
  if (rawOutput) return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;

  if (storedJob?.rendered) {
    return storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
  }

  const lines = [
    `# ${job.title ?? "ZAI Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`,
  ];

  if (job.summary) lines.push(`Summary: ${job.summary}`);
  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = ["# ZAI Cancel", "", `Cancelled ${job.id}.`, ""];
  if (job.title) lines.push(`- Title: ${job.title}`);
  if (job.summary) lines.push(`- Summary: ${job.summary}`);
  lines.push("- Check `/zai:status` for the updated queue.");
  return `${lines.join("\n").trimEnd()}\n`;
}
```

- [ ] **Step 3: Commit**

```bash
git add plugins/zai/scripts/lib/job-control.mjs plugins/zai/scripts/lib/render.mjs
git commit -m "feat(zai): add job control and render modules"
```

---

### Task 8: Core Library — zai.mjs (CLI wrapper)

**Files:**
- Create: `plugins/zai/scripts/lib/zai.mjs`

This is the key module that differs from the gemini plugin. Instead of ACP, we spawn `zai` in headless mode.

- [ ] **Step 1: Write zai.mjs**

```js
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

export async function getZaiAvailability() {
  const check = binaryAvailable("zai", ["--version"]);
  if (!check.available) {
    return { available: false, detail: "zai CLI not found in PATH." };
  }
  const version = check.detail || "unknown";
  return { available: true, version, detail: "ZAI CLI available." };
}

export async function getZaiLoginStatus() {
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

  onProgress?.({ message: "Starting ZAI task...", phase: "starting" });
  appendLogLine(logFile, `Running: zai ${args.map((a) => a.length > 80 ? `"${a.slice(0, 77)}..."` : `"${a}"`).join(" ")}`);

  const result = runCommand("zai", args, { cwd, timeoutMs });

  if (result.error?.code === "ETIMEDOUT") {
    const modelLabel = model ?? "default";
    const structured = new Error(`ZAI task timed out after ${Math.round(timeoutMs / 1000)}s.`);
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
```

- [ ] **Step 2: Commit**

```bash
git add plugins/zai/scripts/lib/zai.mjs
git commit -m "feat(zai): add zai CLI wrapper module"
```

---

### Task 9: Schemas + Prompts

**Files:**
- Create: `plugins/zai/schemas/review-output.schema.json`
- Create: `plugins/zai/schemas/error-output.schema.json`
- Create: `plugins/zai/prompts/adversarial-review.md`
- Create: `plugins/zai/prompts/stop-review-gate.md`

- [ ] **Step 1: Write review-output.schema.json**

Same schema as gemini plugin — the output format is provider-agnostic.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ZaiReviewOutput",
  "description": "Structured output expected from ZAI for code review. Validated at runtime — failures fail closed.",
  "type": "object",
  "required": ["verdict", "summary", "findings", "next_steps"],
  "properties": {
    "verdict": {
      "type": "string",
      "enum": ["no-issues", "needs-attention", "no-ship"]
    },
    "summary": {
      "type": "string",
      "minLength": 1
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["severity", "title", "body"],
        "properties": {
          "severity": { "type": "string", "enum": ["critical", "high", "medium", "low"] },
          "title": { "type": "string", "minLength": 1 },
          "body": { "type": "string", "minLength": 1 },
          "file": { "type": "string" },
          "line_start": { "type": "integer", "minimum": 1 },
          "line_end": { "type": "integer", "minimum": 1 },
          "recommendation": { "type": "string" }
        }
      }
    },
    "next_steps": {
      "type": "array",
      "items": { "type": "string" }
    }
  }
}
```

- [ ] **Step 2: Write error-output.schema.json**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ZaiErrorOutput",
  "description": "Structured error response from the ZAI companion.",
  "type": "object",
  "required": ["error", "code"],
  "properties": {
    "error": { "type": "string" },
    "code": { "type": "string", "enum": ["RATE_LIMITED", "MODEL_UNAVAILABLE", "CLI_ERROR"] },
    "model": { "type": "string" },
    "suggestions": { "type": "array", "items": { "type": "string" } }
  }
}
```

- [ ] **Step 3: Write adversarial-review.md**

Adapted from gemini plugin — same structure, ZAI branding.

```markdown
<role>
You are GLM performing an adversarial software review.
Your job is to break confidence in the change, not to validate it.
</role>

<task>
Review the provided repository context as if you are trying to find the strongest reasons this change should not ship yet.
Target: {{TARGET_LABEL}}
User focus: {{USER_FOCUS}}
</task>

<operating_stance>
Default to skepticism.
Assume the change can fail in subtle, high-cost, or user-visible ways until the evidence says otherwise.
Do not give credit for good intent, partial fixes, or likely follow-up work.
If something only works on the happy path, treat that as a real weakness.
</operating_stance>

<attack_surface>
Prioritize the kinds of failures that are expensive, dangerous, or hard to detect:
- auth, permissions, tenant isolation, and trust boundaries
- data loss, corruption, duplication, and irreversible state changes
- rollback safety, retries, partial failure, and idempotency gaps
- race conditions, ordering assumptions, stale state, and re-entrancy
- empty-state, null, timeout, and degraded dependency behavior
- version skew, schema drift, migration hazards, and compatibility regressions
- observability gaps that would hide failure or make recovery harder
</attack_surface>

<review_method>
Actively try to disprove the change.
Look for violated invariants, missing guards, unhandled failure paths, and assumptions that stop being true under stress.
Trace how bad inputs, retries, concurrent actions, or partially completed operations move through the code.
If the user supplied a focus area, weight it heavily, but still report any other material issue you can defend.
</review_method>

<finding_bar>
Report only material findings.
Do not include style feedback, naming feedback, low-value cleanup, or speculative concerns without evidence.
A finding should answer:
1. What can go wrong?
2. Why is this code path vulnerable?
3. What is the likely impact?
4. What concrete change would reduce the risk?
</finding_bar>

<structured_output_contract>
Return only valid JSON matching the provided schema.
Keep the output compact and specific.
Use `needs-attention` if there is any material risk worth blocking on.
Use `no-issues` only if you cannot support any substantive adversarial finding from the provided context.
Every finding must include the affected file, `line_start`, and a concrete recommendation.
Write the summary like a terse ship/no-ship assessment, not a neutral recap.
</structured_output_contract>

<grounding_rules>
Be aggressive, but stay grounded.
Every finding must be defensible from the provided repository context or tool outputs.
Do not invent files, lines, code paths, incidents, attack chains, or runtime behavior you cannot support.
If a conclusion depends on an inference, state that explicitly in the finding body.
</grounding_rules>

<calibration_rules>
Prefer one strong finding over several weak ones.
Do not dilute serious issues with filler.
If the change looks safe, say so directly and return no findings.
</calibration_rules>

<repository_context>
{{REVIEW_INPUT}}
</repository_context>
```

- [ ] **Step 4: Write stop-review-gate.md**

```markdown
<task>
Run a stop-gate review of the previous Claude turn.
Only review the work from the previous Claude turn.
Only review it if Claude actually did code changes in that turn.
Pure status, setup, or reporting output does not count as reviewable work.
If the previous Claude turn was only a status update, a summary, a setup/login check, a review result, or output from a command that did not itself make direct edits in that turn, return ALLOW immediately and do no further work.
Challenge whether that specific work and its design choices should ship.

{{CLAUDE_RESPONSE_BLOCK}}
</task>

<compact_output_contract>
Return a compact final answer.
Your first line must be exactly one of:
- ALLOW: <short reason>
- BLOCK: <short reason>
Do not put anything before that first line.
</compact_output_contract>

<default_follow_through_policy>
Use ALLOW if the previous turn did not make code changes or if you do not see a blocking issue.
Use ALLOW immediately, without extra investigation, if the previous turn was not an edit-producing turn.
Use BLOCK only if the previous turn made code changes and you found something that still needs to be fixed before stopping.
</default_follow_through_policy>

<grounding_rules>
Ground every blocking claim in the repository context or tool outputs you inspected during this run.
Do not treat the previous Claude response as proof that code changes happened; verify that from the repository state before you block.
Do not block based on older edits from earlier turns when the immediately previous turn did not itself make direct edits.
</grounding_rules>

<dig_deeper_nudge>
If the previous turn did make code changes, check for second-order failures, empty-state behavior, retries, stale state, rollback risk, and design tradeoffs before you finalize.
</dig_deeper_nudge>
```

- [ ] **Step 5: Commit**

```bash
git add plugins/zai/schemas/ plugins/zai/prompts/
git commit -m "feat(zai): add schemas and prompt templates"
```

---

### Task 10: Main Companion Script — zai-companion.mjs

**Files:**
- Create: `plugins/zai/scripts/zai-companion.mjs`

- [ ] **Step 1: Write zai-companion.mjs**

Main entry point — adapted from gemini-companion.mjs. Key difference: no ACP, uses `zai.mjs` wrapper instead. No `interruptSession` — just kill process tree on cancel.

The full file is long (~400 lines). Core structure:

- `handleSetup(argv)` — check zai availability + auth, toggle review gate
- `handleTask(argv)` — foreground or background task via `runTask()`
- `handleTaskWorker(argv)` — background worker for detached jobs
- `handleReview(argv)` — standard review
- `handleReviewCommand(argv, config)` — shared review/adversarial logic
- `handleStatus(argv)` — job status display
- `handleResult(argv)` — fetch stored output
- `handleCancel(argv)` — kill active job
- `main()` — subcommand router

See the full implementation in the companion codeblock below. It follows the exact same patterns as gemini-companion.mjs but replaces all Gemini-specific calls with `zai.mjs` equivalents.

```js
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
```

- [ ] **Step 2: Commit**

```bash
git add plugins/zai/scripts/zai-companion.mjs
git commit -m "feat(zai): add main companion script with all subcommands"
```

---

### Task 11: Hook Scripts

**Files:**
- Create: `plugins/zai/scripts/session-lifecycle-hook.mjs`
- Create: `plugins/zai/scripts/stop-review-gate-hook.mjs`
- Create: `plugins/zai/hooks/hooks.json`

- [ ] **Step 1: Write session-lifecycle-hook.mjs**

```js
#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { loadState, resolveStateFile, saveState } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "ZAI_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") return;
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) return;

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) return;

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) return;

  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) continue;
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  saveState(workspaceRoot, { ...state, jobs: state.jobs.filter((job) => job.sessionId !== sessionId) });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Write stop-review-gate-hook.mjs**

```js
#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { getZaiLoginStatus } from "./lib/zai.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) return;
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) return jobs;
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, { CLAUDE_RESPONSE_BLOCK: claudeResponseBlock });
}

async function buildSetupNote() {
  const authStatus = await getZaiLoginStatus();
  if (authStatus.loggedIn) return null;
  const detail = authStatus.detail ? ` ${authStatus.detail}.` : "";
  return `ZAI is not set up for the review gate.${detail} Run /zai:setup.`;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return { ok: false, reason: "The stop-time ZAI review task returned no final output. Run /zai:review --wait manually or bypass the gate." };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) return { ok: true, reason: null };
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return { ok: false, reason: `ZAI stop-time review found issues: ${reason}` };
  }

  return { ok: false, reason: "The stop-time ZAI review task returned an unexpected answer. Run /zai:review --wait manually or bypass the gate." };
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "zai-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = { ...process.env, ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {}) };
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS,
  });

  if (result.error?.code === "ETIMEDOUT") {
    return { ok: false, reason: "The stop-time ZAI review task timed out after 15 minutes. Run /zai:review --wait manually or bypass the gate." };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return { ok: false, reason: detail ? `The stop-time ZAI review task failed: ${detail}` : "The stop-time ZAI review task failed." };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return { ok: false, reason: "The stop-time ZAI review task returned invalid JSON." };
  }
}

async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `ZAI task ${runningJob.id} is still running. Check /zai:status and use /zai:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = await buildSetupNote();
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    emitDecision({ decision: "block", reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason });
    return;
  }

  logNote(runningTaskNote);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
```

- [ ] **Step 3: Write hooks.json**

```json
{
  "description": "Session lifecycle and optional stop-time review gate for ZAI Companion.",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs\" SessionStart",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs\" SessionEnd",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs\"",
            "timeout": 900
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add plugins/zai/scripts/session-lifecycle-hook.mjs plugins/zai/scripts/stop-review-gate-hook.mjs plugins/zai/hooks/hooks.json
git commit -m "feat(zai): add session lifecycle hooks and stop-gate"
```

---

### Task 12: Commands

**Files:**
- Create: `plugins/zai/commands/setup.md`
- Create: `plugins/zai/commands/task.md`
- Create: `plugins/zai/commands/review.md`
- Create: `plugins/zai/commands/adversarial-review.md`
- Create: `plugins/zai/commands/rescue.md`
- Create: `plugins/zai/commands/status.md`
- Create: `plugins/zai/commands/result.md`
- Create: `plugins/zai/commands/cancel.md`

- [ ] **Step 1: Write setup.md**

```markdown
---
description: Check whether the local ZAI CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

\`\`\`bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" setup --json $ARGUMENTS
\`\`\`

If the result says ZAI is unavailable:
- Tell the user to install the ZAI CLI: `npm install -g @guizmo-ai/zai-cli`
- Do not attempt to install it yourself.

If ZAI is installed but not authenticated:
- Tell the user to set the `ZAI_API_KEY` environment variable or run `zai config`.
- Preserve any guidance in the setup output.

Output rules:
- Present the final setup output to the user.
```

- [ ] **Step 2: Write task.md**

```markdown
---
description: Delegate a task to ZAI CLI as a background or foreground job
argument-hint: '[--background] [--model <model>] [--write] [prompt]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a ZAI task through the companion runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Execution mode rules:
- If `--background` is in the arguments, run in a Claude background task.
- Otherwise, run in the foreground and stream output.

Foreground flow:
- Run:
\`\`\`bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" task $ARGUMENTS
\`\`\`
- Return the command stdout verbatim, exactly as-is.

Background flow:
- Launch with `Bash` in the background:
\`\`\`typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" task $ARGUMENTS`,
  description: "ZAI task",
  run_in_background: true
})
\`\`\`
- Tell the user: "ZAI task started in the background. Check `/zai:status` for progress."
```

- [ ] **Step 3: Write review.md**

```markdown
---
description: Run a ZAI code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a ZAI code review.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return ZAI's output verbatim to the user.

Execution mode rules:
- If `--wait` is in the arguments, run in the foreground without asking.
- If `--background` is in the arguments, run in the background without asking.
- Otherwise, estimate the size using `git status --short` and `git diff --shortstat`:
  - Recommend waiting only for 1-2 file diffs. Recommend background for everything else.
  - Use `AskUserQuestion` exactly once with: `Wait for results` and `Run in background`

Foreground flow:
- Run:
\`\`\`bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" review $ARGUMENTS
\`\`\`
- Return stdout verbatim. Do not fix any issues mentioned.

Background flow:
\`\`\`typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" review $ARGUMENTS`,
  description: "ZAI review",
  run_in_background: true
})
\`\`\`
- Tell the user: "ZAI review started in the background. Check `/zai:status` for progress."
```

- [ ] **Step 4: Write adversarial-review.md**

```markdown
---
description: Run a ZAI review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial ZAI review through the shared plugin runtime.
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return ZAI's output verbatim to the user.

Execution mode rules:
- If `--wait` is in the arguments, run in the foreground without asking.
- If `--background` is in the arguments, run in the background without asking.
- Otherwise, estimate the review size and use `AskUserQuestion` exactly once with two options, recommended first:
  - `Wait for results`
  - `Run in background`

Foreground flow:
\`\`\`bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" adversarial-review "$ARGUMENTS"
\`\`\`
- Return stdout verbatim. Do not fix any issues.

Background flow:
\`\`\`typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" adversarial-review "$ARGUMENTS"`,
  description: "ZAI adversarial review",
  run_in_background: true
})
\`\`\`
- Tell the user: "ZAI adversarial review started in the background. Check `/zai:status` for progress."
```

- [ ] **Step 5: Write rescue.md**

```markdown
---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the ZAI rescue subagent
argument-hint: "[--background|--wait] [--model <model>] [what ZAI should investigate, solve, or continue]"
context: fork
allowed-tools: Bash(node:*)
---

Route this request to the `zai:zai-rescue` subagent.
The final user-visible response must be ZAI's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:
- If the request includes `--background`, run the `zai:zai-rescue` subagent in the background.
- If the request includes `--wait`, run the `zai:zai-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`.
- `--model` is a runtime-selection flag. Preserve it for the forwarded `task` call.

Operating rules:
- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" task ...` and return stdout as-is.
- Return the ZAI companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- If the user did not supply a request, ask what ZAI should investigate or fix.
```

- [ ] **Step 6: Write status.md**

```markdown
---
description: Show active and recent ZAI jobs for this repository
argument-hint: '[job-id] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" status $ARGUMENTS`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
```

- [ ] **Step 7: Write result.md**

```markdown
---
description: Show the stored final output for a finished ZAI job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" result $ARGUMENTS`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload
- File paths and line numbers exactly as reported
- Any error messages
- Follow-up commands such as `/zai:status <id>` and `/zai:review`
```

- [ ] **Step 8: Write cancel.md**

```markdown
---
description: Cancel an active background ZAI job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" cancel $ARGUMENTS`
```

- [ ] **Step 9: Commit**

```bash
git add plugins/zai/commands/
git commit -m "feat(zai): add all command definitions"
```

---

### Task 13: Agent — zai-rescue.md

**Files:**
- Create: `plugins/zai/agents/zai-rescue.md`

- [ ] **Step 1: Write zai-rescue.md**

```markdown
---
name: zai-rescue
description: Proactively use when Claude Code is stuck, wants a second implementation or diagnosis pass, needs a deeper root-cause investigation, or should hand a substantial coding task to GLM through the shared runtime
tools: Bash
skills:
  - zai-cli-runtime
  - zai-prompting
---

You are a thin forwarding wrapper around the ZAI companion task runtime.

Your only job is to forward the user's rescue request to the ZAI companion script. Do not do anything else.

Selection guidance:

- Do not wait for the user to explicitly ask for ZAI. Use this subagent proactively when the main Claude thread should hand a substantial debugging or implementation task to GLM.
- Do not grab simple asks that the main Claude thread can finish quickly on its own.

Forwarding rules:

- Use exactly one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" task ...`.
- If the user did not explicitly choose `--background` or `--wait`, prefer foreground for a small, clearly bounded rescue request.
- If the task looks complicated, open-ended, multi-step, or likely to run for a long time, prefer background execution.
- You may use the `zai-prompting` skill only to tighten the user's request into a better GLM prompt before forwarding it.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`. This subagent only forwards to `task`.
- Leave model unset by default. Only add `--model` when the user explicitly asks for a specific model.
- If the user asks for `flagship`, map that to `--model glm-5.1`.
- If the user asks for `thinking`, map that to `--model glm-4.7`.
- If the user asks for `flash`, map that to `--model glm-4.7-flash`.
- If the user asks for a concrete model name such as `glm-5`, pass it through with `--model`.
- Default to a write-capable ZAI run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.
- Preserve the user's task text as-is apart from stripping routing flags.
- Return the stdout of the `zai-companion` command exactly as-is.
- If the Bash call fails or ZAI cannot be invoked, return nothing.

Response style:

- Do not add commentary before or after the forwarded `zai-companion` output.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/zai/agents/zai-rescue.md
git commit -m "feat(zai): add zai-rescue agent"
```

---

### Task 14: Skills

**Files:**
- Create: `plugins/zai/skills/zai-cli-runtime/SKILL.md`
- Create: `plugins/zai/skills/zai-result-handling/SKILL.md`
- Create: `plugins/zai/skills/zai-prompting/SKILL.md`
- Create: `plugins/zai/skills/zai-prompting/references/glm-prompt-antipatterns.md`
- Create: `plugins/zai/skills/zai-prompting/references/glm-prompt-recipes.md`

- [ ] **Step 1: Write zai-cli-runtime/SKILL.md**

```markdown
---
name: zai-cli-runtime
description: Internal helper contract for calling the zai-companion runtime from Claude Code
user-invocable: false
---

# ZAI Runtime

Use this skill only inside the `zai:zai-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct ZAI CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `zai:zai-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `zai-prompting` skill to rewrite the user's request into a tighter GLM prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Map `flagship` to `--model glm-5.1`.
- Map `thinking` to `--model glm-4.7`.
- Map `flash` to `--model glm-4.7-flash`.
- Default to a write-capable ZAI run by adding `--write` unless the user explicitly asks for read-only behavior.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or ZAI cannot be invoked, return nothing.
```

- [ ] **Step 2: Write zai-result-handling/SKILL.md**

```markdown
---
name: zai-result-handling
description: Internal guidance for presenting ZAI helper output back to the user
user-invocable: false
---

# ZAI Result Handling

When the helper returns ZAI output:
- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If GLM marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If GLM made edits, say so explicitly and list the touched files when the helper provides them.
- For `zai:zai-rescue`, do not turn a failed or incomplete ZAI run into a Claude-side implementation attempt. Report the failure and stop.
- For `zai:zai-rescue`, if GLM was never successfully invoked, do not generate a substitute answer at all.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden.
- If the helper reports malformed output or a failed ZAI run, include the most actionable stderr lines and stop there instead of guessing.
- If the helper reports that setup or authentication is required, direct the user to `/zai:setup` and do not improvise alternate auth flows.
```

- [ ] **Step 3: Write zai-prompting/SKILL.md**

```markdown
---
name: zai-prompting
description: Internal guidance for composing GLM prompts for coding, review, diagnosis, and research tasks inside the ZAI Claude Code plugin
user-invocable: false
---

# GLM Prompting Guide for Coding Tasks

Reference document for writing effective prompts when delegating to GLM models via ZAI CLI.

---

## Model Selection

| Model | Use when | Context | Notes |
|---|---|---|---|
| `glm-5.1` | Complex architecture, cross-file refactors, agentic coding | 200K tokens | Flagship, April 2026 |
| `glm-5` | Large-scale tasks, broad reasoning | 200K tokens | 745B MoE, Feb 2026 |
| `glm-4.7` | Code review, thinking-intensive tasks, debugging | 200K tokens | Thinking/coding model |
| `glm-4.7-flash` | Quick checks, stop-gate, triage | — | Free tier |
| `glm-4.5-flash` | High-volume, low-cost classification | — | Free tier |

**Decision rule:** Default to `glm-5.1` for task/rescue work. Use `glm-4.7` for reviews and thinking-heavy analysis. Use `glm-4.7-flash` for cheap/fast checks. Use `glm-4.5-flash` only when cost is the sole constraint.

---

## Prompt Structure

```
[Role/persona — optional]

[Context: what exists, what matters]

[Task: specific, scoped, explicit]

[Constraints: what NOT to do, style rules]

[Output format: how to structure the response]
```

### Key principles for GLM:
- Be explicit about scope. GLM responds well to clear boundaries.
- Put the task at the end for long-context prompts — GLM handles "needle in haystack" well with task-at-end placement.
- Use structured output instructions when you need JSON — GLM supports OpenAI-compatible function calling.
- For code review, include the diff inline and request JSON output matching the review schema.

---

## Context Window Strategy

GLM models support 200K tokens. Filter aggressively:
- Include only files relevant to the task
- For reviews: the diff is primary context, not the full codebase
- For tasks: include the specific files to modify + their immediate dependencies

---

## Code-Specific Patterns

### Review
- Provide the git diff + file context
- Request structured JSON output (verdict, findings, next_steps)
- Be explicit: "Report only material findings, not style issues"

### Diagnosis
- Include the error/stack trace
- Include the relevant source file(s)
- Ask for root cause analysis, not just a fix

### Refactor
- Show the current code
- Describe the target architecture
- List constraints (no API changes, backward compatible, etc.)

---

## Temperature Guide

| Task | Temperature |
|------|------------|
| Code generation | 0.2-0.4 |
| Code review | 0.1-0.2 |
| Creative problem solving | 0.6-0.8 |
| Classification/routing | 0.0 |
```

- [ ] **Step 4: Write glm-prompt-antipatterns.md**

```markdown
# GLM Prompt Antipatterns

## 1. Vague Scope
**Bad:** "Review this code"
**Good:** "Review only the authentication changes in this diff. Ignore formatting."

## 2. Missing Constraints
**Bad:** "Fix the bug"
**Good:** "Fix the null reference in `processUser()`. Do not change the function signature. Do not modify tests."

## 3. Query Before Context
For long prompts, GLM performs better when the task appears after the context.
**Bad:** "What's wrong with this code? [500 lines of code]"
**Good:** "[500 lines of code] Given the code above, identify the race condition in the connection pool."

## 4. Expecting Structured Output Without Instructions
GLM will return prose unless explicitly told to output JSON.
**Bad:** "Review this and give findings"
**Good:** "Respond with ONLY valid JSON matching this schema: {verdict, summary, findings[], next_steps[]}"

## 5. Overloading a Single Prompt
Break multi-step tasks into separate prompts when each step has different requirements.

## 6. Not Specifying What NOT To Do
GLM tends to over-deliver. Constrain explicitly.
**Bad:** "Improve this function"
**Good:** "Optimize the inner loop for memory. Do not change the API, add dependencies, or restructure the module."

## 7. Ignoring the Free Tier
Use `glm-4.7-flash` or `glm-4.5-flash` for simple classification, routing, and triage instead of burning quota on flagship models.
```

- [ ] **Step 5: Write glm-prompt-recipes.md**

```markdown
# GLM Prompt Recipes

## Code Review with Structured Output
```
You are reviewing a code change. Analyze the diff below for bugs, security issues, and correctness problems.

[diff content]

Respond with ONLY valid JSON — no prose, no markdown fences:
{"verdict":"no-issues"|"needs-attention"|"no-ship","summary":"...","findings":[{"severity":"critical|high|medium|low","title":"...","body":"...","file":"...","line_start":N,"recommendation":"..."}],"next_steps":["..."]}
```

## Focused Diagnosis
```
A test is failing with this error:

[error/stack trace]

The relevant source file:

[source code]

Identify the root cause. List the exact lines that need to change and why. Do not suggest unrelated improvements.
```

## Scoped Refactor
```
Refactor the function below to use async/await instead of callbacks.

[function code]

Constraints:
- Keep the same function signature
- Keep the same error handling behavior
- Do not add new dependencies
```
```

- [ ] **Step 6: Commit**

```bash
git add plugins/zai/skills/
git commit -m "feat(zai): add all skills with prompting guide and references"
```

---

### Task 15: Smoke Test

- [ ] **Step 1: Verify plugin structure**

Run: `find plugins/zai -type f | sort`

Expected: all files from the file map are present.

- [ ] **Step 2: Verify companion script loads**

Run: `node plugins/zai/scripts/zai-companion.mjs help`

Expected: prints usage without errors.

- [ ] **Step 3: Verify setup command runs**

Run: `node plugins/zai/scripts/zai-companion.mjs setup --json`

Expected: returns JSON with `ready: false` or `ready: true` depending on whether `zai` is installed. No crashes.

- [ ] **Step 4: Final commit with any fixes**

If any fixes are needed, apply them and commit:

```bash
git add -A
git commit -m "fix(zai): smoke test fixes"
```
