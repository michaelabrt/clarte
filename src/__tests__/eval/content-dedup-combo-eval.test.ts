/**
 * E.3-lite: Combinatorial eval for content dedup experiment (SS3.45).
 *
 * Same structure as E.2 but with:
 * - temp=0.3 (real variance, the E.3 requirement)
 * - N_ITERS=2 (minimum for directional signal)
 * - 10 tasks: 5 dedup-focused + 5 general architecture (regression detection)
 *
 * Verdict: PASS if both iterations show delta >= -10%, FAIL if any < -15%
 *
 * Pre-generation (same files as E.2):
 *   # 1. Build with dedup (current working tree):
 *   npm run build && echo n | node dist/index.js . --force
 *   cp CLAUDE.md /tmp/clarte-dedup.md
 *
 *   # 2. Build without dedup (stash uncommitted changes):
 *   git stash && npm run build && echo n | node dist/index.js . --force
 *   cp CLAUDE.md /tmp/clarte-nodedup.md && git stash pop
 *
 * Run:   LLM_EVAL=1 N_ITERS=2 npx vitest run src/__tests__/eval/content-dedup-combo-eval.test.ts
 * Cost:  ~$1.00
 */

import { describe, it, expect, beforeAll } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "node:fs";

const SKIP =
  !process.env.LLM_EVAL ||
  !process.env.ANTHROPIC_API_KEY ||
  !existsSync("/tmp/clarte-nodedup.md") ||
  !existsSync("/tmp/clarte-dedup.md");

const N_ITERS = parseInt(process.env.N_ITERS ?? "2", 10);
const MODEL = "claude-sonnet-4-6";
const TEMPERATURE = 0.3;

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

// 5 dedup-focused tasks: test info retention and noise reduction
const DEDUP_TASKS: EvalTask[] = [
  {
    id: "dd-1",
    category: "dedup",
    question:
      "Which file pair has the strongest hidden coupling (high co-change but no direct import path)? Name the pair, their co-change confidence, and explain why this matters for code review.",
    judgePrompt: `Score 1 if the answer:
1. Names package-lock.json and package.json (in either order)
2. States a co-change confidence of approximately 70% (or references "high confidence" / "most of the time")
3. Explains a practical implication (e.g., always review both, lockfile drift risk)
Score 0 if the pair is wrong or no practical implication given. Reply with just "1" or "0".`,
  },
  {
    id: "dd-2",
    category: "dedup",
    question:
      "Name the most tightly coupled file pair in this codebase by number of shared named imports. How many named exports does one import from the other?",
    judgePrompt: `Score 1 if the answer:
1. Names src/graph.ts and src/types.ts (in either order)
2. States approximately 19 named imports (within +/- 3)
Score 0 if the pair is wrong or the count is significantly off. Reply with just "1" or "0".`,
  },
  {
    id: "dd-3",
    category: "dedup",
    question:
      "How many components does src/utils.ts separate as an architectural chokepoint, and how many files import it?",
    judgePrompt: `Score 1 if the answer:
1. States that src/utils.ts separates approximately 5 components
2. States that approximately 33 files import it (within +/- 5)
Score 0 if either number is significantly wrong. Reply with just "1" or "0".`,
  },
  {
    id: "dd-4",
    category: "dedup",
    question:
      "Which file pairs show the highest co-change confidence in this codebase? Name the top 2 pairs and their confidence percentages.",
    judgePrompt: `Score 1 if the answer:
1. Names at least 2 file pairs from the change coupling data
2. For at least one pair, states a confidence percentage that is approximately correct (e.g., hooks.test.ts/hooks.ts at ~83%, package-lock.json/package.json at ~70%, graph.ts/snapshot.ts at ~52%)
Score 0 if fewer than 2 pairs or no confidence percentages given. Reply with just "1" or "0".`,
  },
  {
    id: "dd-5",
    category: "dedup",
    question:
      "Which files are architectural chokepoints whose removal would disconnect parts of the codebase? Name at least 3 and for each state how many components it separates.",
    judgePrompt: `Score 1 if the answer:
1. Names at least 3 files from the chokepoints table (e.g., utils.ts, graph.ts, theme.ts, ast-parse.ts, git-analysis.ts, generate.ts, watch.ts, refresh.ts, hooks.ts)
2. For at least 2 of them, states an approximate component count (e.g., "5 components" for utils.ts or graph.ts)
Score 0 if fewer than 3 chokepoints named or no component counts given. Reply with just "1" or "0".`,
  },
];

// 5 general architecture tasks (regression detection)
const GENERAL_TASKS: EvalTask[] = [
  {
    id: "gen-1",
    category: "architecture",
    question:
      "Rank the top 3 riskiest files to modify in this codebase. For each, cite at least 2 distinct types of evidence from the context.",
    judgePrompt: `Score 1 if the answer:
1. Names 3 specific files from the codebase
2. For each file, cites at least 2 DIFFERENT types of evidence (e.g., churn, coupling, chokepoint status, complexity)
3. At least 2 of the 3 files are among: src/graph.ts, src/index.ts, src/types.ts, src/detect.ts, src/utils.ts
Score 0 if fewer than 3 files or any file lacks 2 evidence types. Reply with just "1" or "0".`,
  },
  {
    id: "gen-2",
    category: "architecture",
    question:
      "A developer submits a PR modifying src/graph.ts. Write a code review checklist: files to check, tests to run, and structural risks.",
    judgePrompt: `Score 1 if the answer:
1. Names at least 3 specific files to check (e.g., types.ts, snapshot.ts, cache.ts, ast-parse.ts)
2. Names at least 2 specific test files to run
3. Mentions at least 1 structural risk (e.g., foundation file, chokepoint, 31 dependents, 36 exports)
Score 0 if fewer than 3 co-change files, fewer than 2 test files, or no structural risk. Reply with just "1" or "0".`,
  },
  {
    id: "gen-3",
    category: "architecture",
    question:
      "What is the dependency flow architecture of this project? Name the layers and explain how imports flow between them.",
    judgePrompt: `Score 1 if the answer:
1. Names at least 2 architectural layers (e.g., types, utils, services)
2. Correctly describes the dependency direction (foundational types are imported by utils, which are imported by services/consumers)
3. Mentions cross-layer edges or violations if applicable
Score 0 if the layers are wrong or the flow direction is reversed. Reply with just "1" or "0".`,
  },
  {
    id: "gen-4",
    category: "architecture",
    question:
      "If you needed to add a new output format (e.g., XML) to this context-generation tool, trace the dependency chain you would modify. Name each file and its role.",
    judgePrompt: `Score 1 if the answer:
1. Names at least 3 real files in a plausible dependency order
2. Includes at least one template-layer file (e.g., templates/main-context.ts or generate.ts)
3. Explains the role of each file (e.g., orchestrator, template renderer, type definitions)
Score 0 if fewer than 3 files or the order is implausible. Reply with just "1" or "0".`,
  },
  {
    id: "gen-5",
    category: "architecture",
    question:
      "Name 2 file pairs from the change coupling data that frequently change together. For each, explain whether their coupling is structural (direct import) or hidden (no import path).",
    judgePrompt: `Score 1 if the answer:
1. Names 2 specific file pairs that appear in the change coupling or hidden coupling data
2. For at least 1 pair, correctly classifies the coupling type (structural = direct import exists, hidden = no direct import)
Score 0 if the pairs aren't from the coupling data or no classification is given. Reply with just "1" or "0".`,
  },
];

const TASKS: EvalTask[] = [...DEDUP_TASKS, ...GENERAL_TASKS];

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
  lines.push("  Content Dedup Experiment: Combo Eval Report (E.3-lite)");
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
    const baselineRate = bPass / total;
    const dedupedRate = dPass / total;
    const delta = dedupedRate - baselineRate;

    lines.push(`  Iteration ${iter + 1}:`);
    lines.push(`    Baseline: ${bPass}/${total} (${(baselineRate * 100).toFixed(1)}%)`);
    lines.push(`    Deduped:  ${dPass}/${total} (${(dedupedRate * 100).toFixed(1)}%)`);
    lines.push(`    Delta:    ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`);
    lines.push("");
  }

  // Aggregate
  const bTotal = results.filter((r) => r.baseline.passed).length;
  const dTotal = results.filter((r) => r.deduped.passed).length;
  const total = results.length;
  const aggDelta = (dTotal - bTotal) / total;

  lines.push("  Aggregate:");
  lines.push(`    Baseline: ${bTotal}/${total} (${(bTotal / total * 100).toFixed(1)}%)`);
  lines.push(`    Deduped:  ${dTotal}/${total} (${(dTotal / total * 100).toFixed(1)}%)`);
  lines.push(`    Delta:    ${aggDelta >= 0 ? "+" : ""}${(aggDelta * 100).toFixed(1)}%`);
  lines.push("");

  // Per-category breakdown
  const categories = [...new Set(TASKS.map((t) => t.category))];
  lines.push("  Per-Category:");
  lines.push(`    ${"Category".padEnd(16)} ${"Baseline".padEnd(10)} ${"Deduped".padEnd(10)} Delta`);
  lines.push(`    ${"-".repeat(50)}`);
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    const catBaseline = catResults.filter((r) => r.baseline.passed).length;
    const catDeduped = catResults.filter((r) => r.deduped.passed).length;
    const catTotal = catResults.length;
    const catDelta = catDeduped - catBaseline;
    const deltaStr = catDelta === 0 ? "  0" : catDelta > 0 ? ` +${catDelta}` : ` ${catDelta}`;
    lines.push(
      `    ${cat.padEnd(16)} ${catBaseline}/${catTotal}`.padEnd(32) +
      `${catDeduped}/${catTotal}`.padEnd(10) +
      deltaStr,
    );
  }
  lines.push("");

  // Per-task detail
  lines.push("  Per-Task Detail:");
  lines.push(`    ${"Task".padEnd(10)} ${"Cat".padEnd(16)} ${"Iter".padEnd(6)} ${"Baseline".padEnd(10)} ${"Deduped".padEnd(10)} Flip`);
  lines.push(`    ${"-".repeat(62)}`);
  for (const r of results) {
    const bStr = r.baseline.passed ? "PASS" : "FAIL";
    const dStr = r.deduped.passed ? "PASS" : "FAIL";
    let flip = "  -";
    if (r.baseline.passed && !r.deduped.passed) flip = "  REGRESS";
    else if (!r.baseline.passed && r.deduped.passed) flip = "  IMPROVE";
    lines.push(
      `    ${r.taskId.padEnd(10)} ${r.category.padEnd(16)} ${String(r.iteration + 1).padEnd(6)} ${bStr.padEnd(10)} ${dStr.padEnd(10)}${flip}`,
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

  // Verdict per iteration
  let allPass = true;
  let anyHardFail = false;
  for (let iter = 0; iter < N_ITERS; iter++) {
    const iterResults = results.filter((r) => r.iteration === iter);
    const bPass = iterResults.filter((r) => r.baseline.passed).length;
    const dPass = iterResults.filter((r) => r.deduped.passed).length;
    const iterDelta = (dPass - bPass) / iterResults.length;
    if (iterDelta < -0.10) allPass = false;
    if (iterDelta < -0.15) anyHardFail = true;
  }

  const verdict = anyHardFail ? "FAIL" : allPass ? "PASS" : "MARGINAL";
  lines.push(`  Verdict: ${verdict}`);
  lines.push(`    PASS requires: delta >= -10% in all iterations`);
  lines.push(`    FAIL if: any iteration delta < -15%`);
  lines.push(sep);

  return lines.join("\n");
}

// -- Test ---------------------------------------------------------------------

describe.skipIf(SKIP)("Content Dedup Combo Eval (E.3-lite)", () => {
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

    // Assertions: check each iteration independently
    for (let iter = 0; iter < N_ITERS; iter++) {
      const iterResults = results.filter((r) => r.iteration === iter);
      const baselinePasses = iterResults.filter((r) => r.baseline.passed).length;
      const dedupedPasses = iterResults.filter((r) => r.deduped.passed).length;
      const iterDelta = (dedupedPasses - baselinePasses) / iterResults.length;

      // Hard fail gate: no iteration should regress more than 15%
      expect(
        iterDelta,
        `Iteration ${iter + 1} regressed by ${(Math.abs(iterDelta) * 100).toFixed(1)}% (hard fail gate: -15%)`,
      ).toBeGreaterThanOrEqual(-0.15);
    }

    // Soft pass gate: all iterations should show delta >= -10%
    for (let iter = 0; iter < N_ITERS; iter++) {
      const iterResults = results.filter((r) => r.iteration === iter);
      const baselinePasses = iterResults.filter((r) => r.baseline.passed).length;
      const dedupedPasses = iterResults.filter((r) => r.deduped.passed).length;
      const iterDelta = (dedupedPasses - baselinePasses) / iterResults.length;

      expect(
        iterDelta,
        `Iteration ${iter + 1} delta ${(iterDelta * 100).toFixed(1)}% below non-inferiority gate (-10%)`,
      ).toBeGreaterThanOrEqual(-0.10);
    }
  }, 900_000); // 15 min timeout
});
