---
description: Run a GLM review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial GLM review through the shared plugin runtime.
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return GLM's output verbatim to the user.

Execution mode rules:
- If `--wait` is in the arguments, run in the foreground without asking.
- If `--background` is in the arguments, run in the background without asking.
- Otherwise, estimate the review size and use `AskUserQuestion` exactly once with two options, recommended first:
  - `Wait for results`
  - `Run in background`

Foreground flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/glm-companion.mjs" adversarial-review "$ARGUMENTS"
```
- Return stdout verbatim. Do not fix any issues.

Background flow:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/glm-companion.mjs" adversarial-review "$ARGUMENTS"`,
  description: "GLM adversarial review",
  run_in_background: true
})
```
- Tell the user: "GLM adversarial review started in the background. Check `/glm:status` for progress."
