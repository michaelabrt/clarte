# Gate A/B: Evolving Context

## Status

Gate A done, Gate B failed (2026-03-06)

## Context

Investigated whether CLAUDE.md content can evolve based on observed agent behavior gaps.

## Method

**Gate A**: Content gap analysis across sessions. Are observations being missed?

**Gate B**: Utilization A/B on matched pairs. Does clarte info actually reduce misses?

## Results

Gate A:
- 59% of sessions show 2+ missed observations
- Signal is bimodal: heavy sessions 78%, light sessions 22%

Gate B:
- Only 21% reduction in misses (threshold was 40%). Failed.
- 100% of missed-test files are already present in rendered CLAUDE.md
- Clarte helps NestJS (33% reduction), hurts Hono single-package (-25%), partial help TypeORM (24%)
- Agents ignore ~70% of test-mapping info even when it's in CLAUDE.md

## Insight

The problem is utilization, not coverage. Agents don't use the information even when it's right there. Future efforts should focus on behavioral steering (how to make agents act on info) rather than content selection (which info to include).
