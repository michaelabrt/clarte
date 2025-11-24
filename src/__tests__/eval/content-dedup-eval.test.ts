/**
 * E.2: Content Dedup Isolated LLM Eval (SS3.45)
 *
 * A/B test: does post-render content deduplication help, hurt, or have
 * no effect on LLM reasoning about the codebase?
 *
 * Baseline: CLAUDE.md generated without dedup (all redundant rows present)
 * Deduped:  CLAUDE.md generated with dedup (redundant P3+ rows removed)
 *
 * 6 tasks (3 info-retention + 3 reasoning), all judge-scored.
 * temp=0, N_ITERS=1 (E.2 spec).
 *
 * Pre-generation (run manually before this test):
 *   # 1. Build with dedup (current working tree):
 *   npm run build && echo n | node dist/index.js . --force
 *   cp CLAUDE.md /tmp/clarte-dedup.md
 *
 *   # 2. Build without dedup (stash uncommitted changes):
 *   git stash && npm run build && echo n | node dist/index.js . --force
 *   cp CLAUDE.md /tmp/clarte-nodedup.md && git stash pop
 *
 * Run: LLM_EVAL=1 npx vitest run src/__tests__/eval/content-dedup-eval.test.ts
 * Cost: ~$0.30
 */

import { describe, it, expect, beforeAll } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "node:fs";

const SKIP =
  !process.env.LLM_EVAL ||
  !process.env.ANTHROPIC_API_KEY ||
  !existsSync("/tmp/clarte-nodedup.md") ||
  !existsSync("/tmp/clarte-dedup.md");

const N_ITERS = parseInt(process.env.N_ITERS ?? "1", 10);
const MODEL = "claude-sonnet-4-6";
const TEMPERATURE = 0;

// Sonnet pricing (per million tokens)
const COST_PER_M_INPUT = 3.0;
const COST_PER_M_OUTPUT = 15.0;

// -- Tasks --------------------------------------------------------------------

interface EvalTask {
  id: string;
  category: string;
  question: string;
  judgePrompt: string;
}

// 3 info-retention tasks: test whether dedup removes metadata that matters.
// The working-guidelines (P2) already mention most files with summary data,
// but P3+ sections carry granular metrics (commit counts, confidence %,
// component counts, import counts) that dedup may strip.
const INFO_TASKS: EvalTask[] = [
  {
    id: "dd-1",
    category: "info-retention",
    question:
      "Which file pair in this codebase has the strongest hidden coupling (files that frequently change together but have no direct import path between them)? Name the pair, the co-change confidence, and explain the practical implication for code review.",
    judgePrompt: `Score 1 if the answer:
1. Names package-lock.json and package.json (in either order)
2. States a co-change confidence of approximately 70% (or references "high confidence" / "most of the time")
3. Explains a practical implication (e.g., always update both together, lockfile drift, review both in the same PR)
Score 0 if it names a different pair or provides no practical implication. Reply with just "1" or "0".`,
  },
  {
    id: "dd-2",
    category: "info-retention",
    question:
      "Name the most tightly coupled file pair in this codebase (by number of shared named imports). How many named exports does one import from the other? What does this coupling level suggest about refactoring risk?",
    judgePrompt: `Score 1 if the answer:
1. Names src/graph.ts and src/types.ts (in either order) as the most tightly coupled pair
2. States approximately 19 named imports (within +/- 2)
3. Mentions a refactoring consequence (e.g., changes to types.ts exports break graph.ts, consider an intermediate interface, high coordination cost)
Score 0 if the pair is wrong, the count is significantly off, or no refactoring insight is given. Reply with just "1" or "0".`,
  },
  {
    id: "dd-3",
    category: "info-retention",
    question:
      "How many components does src/utils.ts separate as an architectural chokepoint? How many files import it? What does this combination mean for a developer who wants to refactor it?",
    judgePrompt: `Score 1 if the answer:
1. States that src/utils.ts separates approximately 5 components
2. States that approximately 33 files import it (within +/- 5)
3. Explains the refactoring risk (e.g., removing or restructuring it would disconnect parts of the codebase AND require updating many importers)
Score 0 if the component count or importer count is significantly wrong, or no practical refactoring insight is given. Reply with just "1" or "0".`,
  },
];

// 3 reasoning tasks: test whether dedup helps or is neutral for synthesis.
const REASONING_TASKS: EvalTask[] = [
  {
    id: "dd-4",
    category: "reasoning",
    question:
      "Rank the top 3 riskiest files to modify in this codebase. For each, cite at least 2 distinct types of evidence from the context (e.g., churn data, coupling, stability rating, chokepoint status, complexity metrics).",
    judgePrompt: `Score 1 if the answer:
1. Names 3 specific files from the codebase
2. For each of the 3 files, cites at least 2 DIFFERENT types of evidence (not just rewording the same fact)
3. At least 2 of the 3 files are among: src/graph.ts, src/index.ts, src/types.ts, src/detect.ts, src/utils.ts
Score 0 if fewer than 3 files are ranked or any file has fewer than 2 evidence types. Reply with just "1" or "0".`,
  },
  {
    id: "dd-5",
    category: "reasoning",
    question:
      "A developer submits a PR that modifies src/graph.ts. Write a code review checklist: what other files should be checked, what tests should run, and what specific structural risks should the reviewer watch for?",
    judgePrompt: `Score 1 if the answer:
1. Names at least 3 specific files that should be checked (e.g., types.ts, snapshot.ts, cache.ts, ast-parse.ts, index.ts)
2. Names at least 2 specific test files to run (from the test coverage map)
3. Mentions at least 1 structural risk (e.g., it is a foundation/chokepoint, 31 files depend on it, high complexity with 36 exports)
Score 0 if fewer than 3 co-change files, fewer than 2 test files, or no structural risk mentioned. Reply with just "1" or "0".`,
  },
  {
    id: "dd-6",
    category: "reasoning",
    question:
      "This project generates context files for AI coding agents. If you needed to add support for a new output format (e.g., XML instead of Markdown), trace the dependency chain you would modify. Start from the entry point and name each intermediate file along with its architectural role.",
    judgePrompt: `Score 1 if the answer:
1. Names at least 3 real files from the codebase in a plausible dependency order
2. Includes at least one template-layer file (e.g., templates/main-context.ts or generate.ts)
3. Explains the architectural role of each file (e.g., "index.ts orchestrates the pipeline", "main-context.ts renders sections", "types.ts defines data structures")
Score 0 if fewer than 3 files or the dependency order is implausible. Reply with just "1" or "0".`,
  },
];

const TASKS: EvalTask[] = [...INFO_TASKS, ...REASONING_TASKS];

// -- Types --------------------------------------------------------------------

interface CallResult {
  answer: string;
  passed: boolean;
  inputTokens: number;
  outputTokens: number;
}

interface TaskResult {
  taskId: string;
  category: string;
  iteration: number;
  baseline: CallResult;
  deduped: CallResult;
}

// -- Helpers ------------------------------------------------------------------

let client: Anthropic;
let baselineContext: string;
let dedupedContext: string;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.2);
}

function costFromTokens(input: number, output: number): number {
  return (input / 1_000_000) * COST_PER_M_INPUT + (output / 1_000_000) * COST_PER_M_OUTPUT;
}

async function askWithContext(
  context: string,
  question: string,
): Promise<{ answer: string; inputTokens: number; outputTokens: number }> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    temperature: TEMPERATURE,
    messages: [
      {
        role: "user",
        content:
          `You are an expert developer analyzing a codebase. Here is the project's CLAUDE.md context file:\n\n<context>\n${context}\n</context>\n\nAnswer this question concisely:\n${question}`,
      },
    ],
  });

  const block = response.content[0];
  const answer = block.type === "text" ? block.text : "";
  return {
    answer,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

async function judgeAnswer(
  answer: string,
  judgePrompt: string,
): Promise<{ passed: boolean; inputTokens: number; outputTokens: number }> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 10,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: `Here is an answer to evaluate:\n\n<answer>\n${answer}\n</answer>\n\n${judgePrompt}`,
      },
    ],
  });

  const block = response.content[0];
  const passed = block.type === "text" && block.text.trim() === "1";
  return {
    passed,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

async function scoreTask(context: string, task: EvalTask): Promise<CallResult> {
  const { answer, inputTokens, outputTokens } = await askWithContext(context, task.question);
  const judge = await judgeAnswer(answer, task.judgePrompt);
  return {
    answer,
    passed: judge.passed,
    inputTokens: inputTokens + judge.inputTokens,
    outputTokens: outputTokens + judge.outputTokens,
  };
}

// -- Report formatting --------------------------------------------------------

function formatReport(
  results: TaskResult[],
  baselineBytes: number,
  dedupedBytes: number,
): string {
  const sep = "=".repeat(72);
  const lines: string[] = [];

  const baselineTokensEst = estimateTokens(baselineContext);
  const dedupedTokensEst = estimateTokens(dedupedContext);
  const sizeDelta = ((dedupedBytes - baselineBytes) / baselineBytes * 100).toFixed(1);

  lines.push("");
  lines.push(sep);
  lines.push("  Content Dedup Experiment: A/B Eval Report (E.2)");
  lines.push(sep);
  lines.push("");
  lines.push(`  Config: model=${MODEL}, temp=${TEMPERATURE}, iters=${N_ITERS}`);
  lines.push("");
  lines.push("  Context Sizes:");
  lines.push(`    Baseline (no dedup):  ${baselineBytes.toLocaleString()} bytes  (~${baselineTokensEst.toLocaleString()} tokens)`);
  lines.push(`    Deduped:              ${dedupedBytes.toLocaleString()} bytes  (~${dedupedTokensEst.toLocaleString()} tokens)`);
  lines.push(`    Delta:                ${sizeDelta}%`);
  lines.push(`    Token savings:        ~${(baselineTokensEst - dedupedTokensEst).toLocaleString()} tokens`);
  lines.push("");

  // Per-iteration
  for (let iter = 0; iter < N_ITERS; iter++) {
    const iterResults = results.filter((r) => r.iteration === iter);
    const bPass = iterResults.filter((r) => r.baseline.passed).length;
    const dPass = iterResults.filter((r) => r.deduped.passed).length;
    const total = iterResults.length;
    const delta = (dPass - bPass) / total;
    lines.push(`  Iteration ${iter + 1}: baseline=${bPass}/${total}, deduped=${dPass}/${total}, delta=${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(0)}%`);
  }
  lines.push("");

  // Aggregate
  const bTotal = results.filter((r) => r.baseline.passed).length;
  const dTotal = results.filter((r) => r.deduped.passed).length;
  const total = results.length;
  const aggDelta = (dTotal - bTotal) / total;

  lines.push(`  Aggregate: baseline=${bTotal}/${total} (${(bTotal / total * 100).toFixed(0)}%), deduped=${dTotal}/${total} (${(dTotal / total * 100).toFixed(0)}%)`);
  lines.push(`  Delta: ${aggDelta >= 0 ? "+" : ""}${(aggDelta * 100).toFixed(1)}%`);
  lines.push("");

  // Per-category breakdown
  const categories = [...new Set(TASKS.map((t) => t.category))];
  lines.push("  Per-Category:");
  lines.push(`    ${"Category".padEnd(18)} ${"Baseline".padEnd(10)} ${"Deduped".padEnd(10)} Delta`);
  lines.push(`    ${"-".repeat(50)}`);
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    const catBaseline = catResults.filter((r) => r.baseline.passed).length;
    const catDeduped = catResults.filter((r) => r.deduped.passed).length;
    const catTotal = catResults.length;
    const catDelta = catDeduped - catBaseline;
    const deltaStr = catDelta === 0 ? "  0" : catDelta > 0 ? ` +${catDelta}` : ` ${catDelta}`;
    lines.push(
      `    ${cat.padEnd(18)} ${catBaseline}/${catTotal}`.padEnd(34) +
      `${catDeduped}/${catTotal}`.padEnd(10) +
      deltaStr,
    );
  }
  lines.push("");

  // Per-task detail
  lines.push("  Per-Task Detail:");
  lines.push(`    ${"Task".padEnd(10)} ${"Cat".padEnd(18)} ${"Iter".padEnd(6)} ${"Baseline".padEnd(10)} ${"Deduped".padEnd(10)} Flip`);
  lines.push(`    ${"-".repeat(64)}`);
  for (const r of results) {
    const bStr = r.baseline.passed ? "PASS" : "FAIL";
    const dStr = r.deduped.passed ? "PASS" : "FAIL";
    let flip = "  -";
    if (r.baseline.passed && !r.deduped.passed) flip = "  REGRESS";
    else if (!r.baseline.passed && r.deduped.passed) flip = "  IMPROVE";
    lines.push(
      `    ${r.taskId.padEnd(10)} ${r.category.padEnd(18)} ${String(r.iteration + 1).padEnd(6)} ${bStr.padEnd(10)} ${dStr.padEnd(10)}${flip}`,
    );
  }
  lines.push("");

  // Cost
  const bIn = results.reduce((a, r) => a + r.baseline.inputTokens, 0);
  const bOut = results.reduce((a, r) => a + r.baseline.outputTokens, 0);
  const dIn = results.reduce((a, r) => a + r.deduped.inputTokens, 0);
  const dOut = results.reduce((a, r) => a + r.deduped.outputTokens, 0);
  const totalCost = costFromTokens(bIn, bOut) + costFromTokens(dIn, dOut);

  lines.push("  Token Usage:");
  lines.push(`    Baseline: ${bIn.toLocaleString()} in / ${bOut.toLocaleString()} out  ($${costFromTokens(bIn, bOut).toFixed(3)})`);
  lines.push(`    Deduped:  ${dIn.toLocaleString()} in / ${dOut.toLocaleString()} out  ($${costFromTokens(dIn, dOut).toFixed(3)})`);
  lines.push(`    Total:    $${totalCost.toFixed(3)}`);
  lines.push("");

  // Verdict
  const nonInferior = aggDelta >= -0.10;
  lines.push(`  Verdict: ${nonInferior ? "PASS" : "FAIL"} (non-inferiority gate: delta >= -10%)`);
  lines.push(sep);

  return lines.join("\n");
}

// -- Test ---------------------------------------------------------------------

describe.skipIf(SKIP)("Content Dedup A/B Eval (E.2)", () => {
  beforeAll(() => {
    client = new Anthropic();
    baselineContext = readFileSync("/tmp/clarte-nodedup.md", "utf-8");
    dedupedContext = readFileSync("/tmp/clarte-dedup.md", "utf-8");
  });

  it(`runs ${N_ITERS} iteration(s) of ${TASKS.length} tasks (temp=${TEMPERATURE})`, async () => {
    const results: TaskResult[] = [];

    for (let iter = 0; iter < N_ITERS; iter++) {
      console.log(`\n-- Iteration ${iter + 1}/${N_ITERS} (temp=${TEMPERATURE}) --`);

      for (const task of TASKS) {
        const [baselineResult, dedupedResult] = await Promise.all([
          scoreTask(baselineContext, task),
          scoreTask(dedupedContext, task),
        ]);

        results.push({
          taskId: task.id,
          category: task.category,
          iteration: iter,
          baseline: baselineResult,
          deduped: dedupedResult,
        });

        const bIcon = baselineResult.passed ? "PASS" : "FAIL";
        const dIcon = dedupedResult.passed ? "PASS" : "FAIL";
        console.log(`  ${task.id.padEnd(8)} baseline=${bIcon}  deduped=${dIcon}`);
      }
    }

    // Report
    const report = formatReport(
      results,
      Buffer.byteLength(baselineContext, "utf-8"),
      Buffer.byteLength(dedupedContext, "utf-8"),
    );
    console.log(report);

    // Assertions
    const bTotal = results.filter((r) => r.baseline.passed).length;
    const dTotal = results.filter((r) => r.deduped.passed).length;
    const delta = (dTotal - bTotal) / results.length;

    // Non-inferiority: deduped should not regress more than 10%
    expect(
      delta,
      `Deduped regressed by ${(Math.abs(delta) * 100).toFixed(1)}% (non-inferiority gate: -10%)`,
    ).toBeGreaterThanOrEqual(-0.10);
  }, 600_000); // 10 min timeout
});
