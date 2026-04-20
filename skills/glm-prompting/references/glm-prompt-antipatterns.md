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
