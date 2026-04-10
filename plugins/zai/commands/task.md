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
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" task $ARGUMENTS
```
- Return the command stdout verbatim, exactly as-is.

Background flow:
- Launch with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" task $ARGUMENTS`,
  description: "ZAI task",
  run_in_background: true
})
```
- Tell the user: "ZAI task started in the background. Check `/zai:status` for progress."
