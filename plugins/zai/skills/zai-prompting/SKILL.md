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
