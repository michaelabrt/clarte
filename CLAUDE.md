# Project Context

See `.claude/rules/clarte.md` for full architectural context.

First action on every coding task: call Agent(subagent_type="clarte-pre-flight", prompt="<your full task>"). It reads the relevant files and returns exact edit instructions. Apply them directly - do not read files yourself before or after. Skip this step if `.clarte/task-context.md` does not exist.

<!-- clarte: generated 2026-03-15T12:57:40Z. Run npx clarte to regenerate. -->

<!-- clarte:user-start -->
## Style Rules

- Angular commit style
<!-- clarte:user-end -->
