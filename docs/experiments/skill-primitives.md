# R.19: Composable Skill Primitives

## Status

Smoke tested (2026-03-08)

## Context

Tested whether generated scripts + imperative CLAUDE.md directives can steer agent behavior.

## Method

Implemented `check-tests.sh` script generation. Tested UserPromptSubmit hook for injecting edit targets (binary analysis + empirical test). Tested `--append-system-prompt` CLI flag. n=1 smoke tests.

## Results

- UserPromptSubmit `additionalContext`: dead code in Claude Code 2.1.71 (hook fires, output silently discarded)
- `--append-system-prompt` CLI flag: works (lands in system prompt, prompt-cached at 90% discount)
- `check-tests.sh` + CLAUDE.md directive: agent obeyed directive and used the script
- Critical finding on phrasing: "Always use .clarte/scripts/check-tests.sh instead of running tests directly" works. "To verify tests, run .clarte/scripts/check-tests.sh" is ignored.

## Insight

Imperative phrasing ("Always use X instead of Y") is obeyed. Soft phrasing ("To verify, run X") is ignored. Behavioral directives must be framed as commands, not suggestions.
