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
