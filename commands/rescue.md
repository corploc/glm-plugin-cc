---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the GLM rescue subagent
argument-hint: "[--background|--wait] [--model <model>] [what GLM should investigate, solve, or continue]"
context: fork
allowed-tools: Bash(node:*)
---

Route this request to the `glm:glm-rescue` subagent.
The final user-visible response must be GLM's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:
- If the request includes `--background`, run the `glm:glm-rescue` subagent in the background.
- If the request includes `--wait`, run the `glm:glm-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`.
- `--model` is a runtime-selection flag. Preserve it for the forwarded `task` call.

Operating rules:
- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/glm-companion.mjs" task ...` and return stdout as-is.
- Return the GLM companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- If the user did not supply a request, ask what GLM should investigate or fix.
