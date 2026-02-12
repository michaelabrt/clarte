# R.12 / R.13b: Hook Context Injection

## Status

Done / Killed (2026-03-07)

## Context

Tested whether Claude Code hooks can inject useful context to agents. Covers PostToolUse `additionalContext` (R.12) and PreToolUse `updatedInput` (R.13b).

## Method

**R.12**: PostToolUse on Bash test commands. Parsed test output, injected structured summary via `additionalContext`. n=5 per arm, TypeORM, detailed prompt.

**R.13b**: Binary analysis of Claude Code 2.1.71. Empirical testing of `updatedInput` field on hook output.

## Results

R.12 PostToolUse `additionalContext`:
- +9% turns (34.0 vs 31.2), +34% cost ($0.79 vs $0.59). Hook hurts.

All hook experiments cumulative:
- PreToolUse read hints: +23% turns, +29% cost
- PreToolUse write hints: +13% turns, +16% cost
- PostToolUse test summary: +9% turns, +34% cost

R.13b:
- `updatedInput` field is in the JSON schema but silently ignored by Claude Code 2.1.71
- Hook fires, correct JSON output, field discarded
- Only `permissionDecision: "deny"` produces observable behavior change

## Insight

Any injected context adds processing overhead. Agents don't shortcut; they process all context. The entire hook context injection path is dead for Claude Code. Only blocking (deny with reason) works.
