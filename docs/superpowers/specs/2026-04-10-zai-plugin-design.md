# ZAI Plugin for Claude Code — Design Spec

## Overview

Plugin Claude Code pour GLM (Z.ai / Zhipu AI), full parity avec `gemini-plugin-cc`.
Wrappe le CLI communautaire `@guizmo-ai/zai-cli` en mode headless pour l'agency.

## Decisions

| Decision | Choice |
|----------|--------|
| Scope | Full parity avec gemini-plugin-cc |
| Backend | Wrapper `zai` CLI (mode headless, agentic natif) |
| Namespace | `zai:` |
| Default models | review: `glm-4.7`, task/rescue: `glm-5.1`, stop-gate: `glm-4.7-flash` |
| Protocol | Spawn process + stream stdout (pas d'ACP, pas de broker) |

## Plugin Structure

```
plugins/zai/
├── .claude-plugin/
│   └── plugin.json
├── agents/
│   └── zai-rescue.md
├── commands/
│   ├── setup.md
│   ├── review.md
│   ├── adversarial-review.md
│   ├── task.md
│   ├── rescue.md
│   ├── status.md
│   ├── result.md
│   └── cancel.md
├── hooks/
│   └── hooks.json
├── prompts/
│   ├── adversarial-review.md
│   └── stop-review-gate.md
├── schemas/
│   ├── review-output.schema.json
│   └── error-output.schema.json
├── scripts/
│   ├── zai-companion.mjs
│   ├── session-lifecycle-hook.mjs
│   ├── stop-review-gate-hook.mjs
│   └── lib/
│       ├── args.mjs
│       ├── fs.mjs
│       ├── git.mjs
│       ├── job-control.mjs
│       ├── models.mjs
│       ├── process.mjs
│       ├── prompts.mjs
│       ├── render.mjs
│       ├── state.mjs
│       ├── tracked-jobs.mjs
│       ├── workspace.mjs
│       └── zai.mjs
└── skills/
    ├── zai-cli-runtime/
    │   └── SKILL.md
    ├── zai-prompting/
    │   ├── SKILL.md
    │   └── references/
    │       ├── glm-prompt-antipatterns.md
    │       └── glm-prompt-recipes.md
    └── zai-result-handling/
        └── SKILL.md
```

## Companion Script

Entry point: `node zai-companion.mjs <command> [flags]`

### Subcommands

```
setup [--json] [--enable-review-gate|--disable-review-gate]
review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]
adversarial-review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus]
task [--background] [--write] [--model <model>] [--resume-last|--fresh] [prompt]
status [job-id] [--all] [--json]
result [job-id] [--json]
cancel [job-id] [--json]
```

### Task Flow

1. Parse args, resolve workspace root
2. Spawn `zai --prompt "<prompt>" --model <model>` headless
3. Stream stdout to log file + console
4. Track job in state (pid, status, phase, elapsed)
5. If `--background`: detach, return job-id

### Review Flow

1. Resolve git scope (working-tree vs branch diff)
2. Collect diff + modified files
3. Build prompt with diff context + review instructions
4. Spawn `zai --prompt "<prompt>" --model glm-4.7`
5. Parse output, validate against `review-output.schema.json`
6. Render findings formatted

## Wrapper CLI (`zai.mjs`)

```js
getZaiAvailability()    // which zai -> exists in PATH?
getZaiVersion()         // zai --version -> parse semver
getZaiLoginStatus()     // check ~/.zai/user-settings.json or ZAI_API_KEY
runTask(prompt, opts)   // spawn headless, stream stdout
runReview(diff, opts)   // build review prompt, spawn, validate schema
killJob(pid)            // SIGTERM -> SIGKILL after timeout
```

### Timeouts

- Task: 300s default
- Review: 600s default
- Stop-gate: 30s

## Hooks

| Hook | Script | Timeout | Role |
|------|--------|---------|------|
| SessionStart | `session-lifecycle-hook.mjs SessionStart` | 5s | Export `ZAI_COMPANION_SESSION_ID` + `CLAUDE_PLUGIN_DATA` |
| SessionEnd | `session-lifecycle-hook.mjs SessionEnd` | 5s | Kill active jobs, cleanup state |
| Stop | `stop-review-gate-hook.mjs` | 900s | Opt-in review gate, ALLOW/BLOCK |

Stop-gate disabled by default. Enable via `/zai:setup --enable-review-gate`.

## Agent: `zai-rescue`

- Thin forwarder to `zai-companion.mjs task`
- Tools: Bash only
- Skills: `zai-cli-runtime`, `zai-prompting`
- Default `--write` unless read-only requested
- Returns stdout verbatim, no summarization
- Supports `--model`, `--resume-last`, `--fresh`

## Skills

### `zai-cli-runtime`
Internal contract — how to call the companion from subagent. Which command, which flags, when `--write` vs not.

### `zai-prompting`
GLM prompting guide adapted to model specifics:
- Model selection: glm-5.1 (flagship), glm-4.7 (thinking/code), glm-4.7-flash (free/fast)
- 200K context window
- Function calling (OpenAI-compatible format)
- Thinking mode on glm-4.6/4.7
- Antipatterns and recipes in `references/`

### `zai-result-handling`
How to present GLM output to user:
- Preserve findings, verdicts, summaries, next steps
- Keep file paths and line numbers exact
- Never auto-apply review fixes — ask user first
- Report malformed output/failures transparently

## Schemas

### `review-output.schema.json`
```json
{
  "verdict": "no-issues" | "needs-attention" | "no-ship",
  "summary": "<string>",
  "findings": [{
    "severity": "critical" | "high" | "medium" | "low",
    "title": "<string>",
    "body": "<string>",
    "file": "<string>",
    "line_start": "<int>",
    "line_end": "<int>",
    "recommendation": "<string>"
  }],
  "next_steps": ["<string>"]
}
```

### `error-output.schema.json`
```json
{
  "error": "<string>",
  "code": "RATE_LIMITED" | "MODEL_UNAVAILABLE" | "CLI_ERROR",
  "model": "<string>",
  "suggestions": ["<string>"]
}
```

## Models

| Model | Context | Price | Default For |
|-------|---------|-------|-------------|
| `glm-5.1` | 200K | paid | task, rescue |
| `glm-4.7` | 200K | paid | review, adversarial-review |
| `glm-4.7-flash` | — | free | stop-gate |
| `glm-4.5-flash` | — | free | (alias: flash) |

All overridable via `--model` flag.

## State Management

Storage: `${CLAUDE_PLUGIN_DATA}/state/<workspace-slug>-<hash>/`
Fallback: `/tmp/zai-companion/`

- Job registry + config in state dir
- Max 50 jobs per workspace
- Session-scoped cleanup on SessionEnd
- Config: `stopReviewGate` toggle

## Key Differences from Gemini Plugin

| Aspect | Gemini | ZAI |
|--------|--------|-----|
| CLI | `gemini` (Google official) | `zai` (`@guizmo-ai/zai-cli`, community) |
| Protocol | ACP (bidirectional agent protocol) | Headless spawn + stdout stream |
| No ACP modules | `acp-client.mjs`, `acp-lifecycle.mjs` | Not needed |
| Auth check | Gemini auth flow | `ZAI_API_KEY` or `~/.zai/user-settings.json` |
| Model names | gemini-2.5-pro, flash, etc. | glm-5.1, glm-4.7, glm-4.7-flash |
| API compat | Google proprietary | OpenAI-compatible |
