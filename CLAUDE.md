# Project Context

See `.claude/rules/clarte.md` for full architectural context.

First action on every coding task: call Agent(subagent_type="clarte-pre-flight", prompt="<your full task>"). It reads the target files and reports where to edit. After applying the pre-flight fix, grep the same file for the pattern you just changed - the same bug often repeats in other functions. Skip this step if `.clarte/task-context.md` does not exist.

<!-- clarte: generated 2026-03-17T00:32:35Z. Run npx clarte to regenerate. -->

<!-- clarte:user-start -->
## Style Rules

- Angular commit style
<!-- clarte:user-end -->
