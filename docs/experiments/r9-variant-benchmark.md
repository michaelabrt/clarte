# R9: Variant Benchmark (E, D, F, C)

## Date: 2026-03-06

## Hypothesis

Four alternative approaches to context delivery might outperform placebo on single-package projects:

- **E** (reorder + compress): Put behavioral instructions first, file-index last, use flat format instead of markdown tables
- **D** (negative framing): Constraint language ("NEVER do X") instead of positive guidance
- **F** (ultra-minimal): Only behavioral + what-is-this + tech-stack + development (no file-index)
- **C** (hook delivery): Minimal CLAUDE.md, deliver per-file context via Write/Edit hooks at mutation time

## Setup

- Target: TypeORM (`typeorm/typeorm@65dea3c0`)
- Issue: #6326 (SQLite simple-enum array) - detailed prompt
- Model: Sonnet
- 3 runs per condition, all parallel
- Implemented as `--variant=E|D|F|C` flag

## Results (preliminary, n=3)

| Condition | Avg Turns | Avg Cost | vs Placebo (turns) | vs Placebo (cost) |
|-----------|-----------|----------|--------------------|--------------------|
| placebo | 31.3 | $0.61 | baseline | baseline |
| exp-E | 31.7 | $0.66 | +1.3% | +8% |
| exp-D | 33.0 | $0.67 | +5.4% | +10% |
| exp-F | 35.0 | $0.65 | +11.8% | +7% |
| exp-C | 35.3 | $0.71 | +12.8% | +16% |

### Per-run data

| Condition | Run 1 | Run 2 | Run 3 |
|-----------|-------|-------|-------|
| placebo | 33t / $0.69 | 29t / $0.73 | 32t / $0.42 |
| exp-E | 28t / $0.46 | 33t / $0.71 | 34t / $0.80 |
| exp-D | 36t / $0.73 | 32t / $0.66 | 31t / $0.63 |
| exp-F | 33t / $0.57 | 37t / $0.67 | 35t / $0.71 |
| exp-C | 44t / $0.84 | 32t / $0.65 | 30t / $0.63 |

## Analysis

**No variant beats placebo.** Consistent with prior 17 experiments on single-package projects.

**E (reorder + compress)**: Closest to placebo but no measurable benefit. The compressed file-index format and Lost-in-the-Middle reordering made no difference. Hypothesis: at lean-mode sizes (~8 sections), there is no "middle" to get lost in.

**D (negative framing)**: Slight hurt (+5.4% turns). Constraint framing ("NEVER do X") doesn't change agent behavior vs the positive version. Agents already follow positive instructions well; negating them adds cognitive overhead without benefit.

**F (ultra-minimal)**: Removing file-index hurt (+11.8% turns). This contradicts the "less is more" hypothesis. The file-index (present in lean mode, absent in F) appears to provide navigation value even on single-package projects. Or: removing development instructions (build/test commands) forces more discovery turns.

**C (hook delivery)**: Worst performer (+12.8% turns, +16% cost). Confirms R4 finding that injection-based delivery adds overhead. The run-1 outlier (44 turns) is typical of the "re-read spiral" where hook context triggers unnecessary exploration. Write/Edit hooks fire less often than Read hooks, but the overhead per trigger is similar.

## Status

**Preliminary no-go.** Branch kept open pending potential additional runs on different targets (monorepo, opaque prompt). Results are consistent with all prior experiments but n=3 is small.

## Remaining questions

- Would any variant help on monorepo targets (where full clarte already helps)?
- Does C perform differently on opaque prompts where the agent genuinely lacks path information?
- Is the file-index finding (F worse than placebo) robust at larger n?
