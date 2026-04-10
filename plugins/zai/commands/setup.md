---
description: Check whether the local ZAI CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" setup --json $ARGUMENTS
```

If the result says ZAI is unavailable:
- Tell the user to install the ZAI CLI: `npm install -g @guizmo-ai/zai-cli`
- Do not attempt to install it yourself.

If ZAI is installed but not authenticated:
- Tell the user to set the `ZAI_API_KEY` environment variable or run `zai config`.
- Preserve any guidance in the setup output.

Output rules:
- Present the final setup output to the user.
