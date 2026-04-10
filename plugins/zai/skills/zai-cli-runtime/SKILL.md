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
