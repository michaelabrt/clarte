/**
 * E.3-lite: Minimal combo sanity check for directed betweenness experiment.
 *
 * Same structure as E.2 but with:
 * - temp=0.3 (real variance, the E.3 requirement)
 * - N_ITERS=2 (minimum for directional signal)
 * - 10 tasks: 5 bottleneck + 5 general architecture (regression detection)
 *
 * Verdict: PASS if both iterations show delta >= -10%, FAIL if any < -15%
 *
 * Pre-generation (run manually before this test):
 *   # On main:   npx clarte && cp .claude/CLAUDE.md /tmp/clarte-undirected-claude.md
 *   # On branch: npx clarte && cp .claude/CLAUDE.md /tmp/clarte-directed-claude.md
 *
 * Skipped unless LLM_EVAL=1 and ANTHROPIC_API_KEY are set.
 *
 * Run:   LLM_EVAL=1 N_ITERS=2 npx vitest run src/__tests__/eval/betweenness-combo-eval.test.ts
 * Cost:  ~$3.00 (all tasks use judge scoring)
 */

import { describe, it, expect, beforeAll } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";

const SKIP = !process.env.LLM_EVAL || !process.env.ANTHROPIC_API_KEY;
const N_ITERS = parseInt(process.env.N_ITERS ?? "2", 10);
const MODEL = "claude-sonnet-4-6";
const TEMPERATURE = 0.3;

// Sonnet pricing (per million tokens)
const COST_PER_M_INPUT = 3.0;
const COST_PER_M_OUTPUT = 15.0;

// ── Tasks ────────────────────────────────────────────────────────────────────

interface EvalTask {
  id: string;
  category: string;
  question: string;
  requiredKeywords?: string[];
  judgePrompt?: string;
}

// 5 bottleneck-focused tasks (same as E.2)
const BOTTLENECK_TASKS: EvalTask[] = [
  {
    id: "btn-1",
    category: "bottleneck",
    question:
      "Which files sit on the most directed import paths in this codebase? Name at least 2 and explain what upstream impact a breaking change in each would have on its transitive dependents.",
    judgePrompt: `Score 1 if the answer:
1. Names at least 2 specific files (e.g., graph.ts, utils.ts, theme.ts, generate.ts)
2. For at least 2 of them, explains transitive dependency impact (not just "many files import it", but HOW changes propagate through the directed import chain to downstream consumers)
Score 0 otherwise. Reply with just "1" or "0".`,
  },
  {
    id: "btn-2",
    category: "bottleneck",
    question:
      "There are two different kinds of risk for a file: coupling risk (many files import it directly) and flow-position risk (it sits on many transitive directed paths). Give one example of each from this codebase and explain the conceptual difference.",
    judgePrompt: `Score 1 if the answer:
1. Names two different files, one for coupling risk and one for flow-position risk
2. Explains the conceptual distinction: coupling risk = high direct import count, flow-position risk = sitting on many transitive directed paths between other files
Score 0 if it conflates the two concepts or only names one file. Reply with just "1" or "0".`,
  },
  {
    id: "btn-3",
    category: "bottleneck",
    question:
      "Trace the directed import paths from the feature entry points (like index.ts or watch.ts) down to the foundational types. Name at least 3 intermediate files that sit on these paths and explain what would break if each were split into two modules.",
    judgePrompt: `Score 1 if the answer:
1. Names at least 3 specific intermediate files that plausibly sit on directed import paths between entry points and foundations
2. For each, gives a concrete consequence of splitting it (e.g., "graph.ts split would break watch.ts because it imports findChokepoints which depends on buildImportGraph")
Score 0 otherwise. Reply with just "1" or "0".`,
  },
  {
    id: "btn-4",
    category: "bottleneck",
    question:
      "Find a file in this codebase that has high in-degree (many files import it) but would have zero directed betweenness centrality because no directed paths pass through it. Explain why directionality matters for this file.",
    judgePrompt: `Score 1 if the answer:
1. Names a specific file that is a pure dependency sink (e.g., types.ts) or explains the concept of a sink
2. Explains why directionality matters: in a directed graph, no paths pass THROUGH a sink because it has no outgoing edges, so its betweenness is zero despite high in-degree
Score 0 if it doesn't address directionality or conflates in-degree with betweenness. Reply with just "1" or "0".`,
  },
  {
    id: "btn-5",
    category: "bottleneck",
    question:
      "Rank the top 3 files by modification risk using flow-based reasoning (not just import count). For each file, explain your reasoning in terms of how many directed dependency chains pass through it.",
    judgePrompt: `Score 1 if the answer:
1. Ranks 3 specific files
2. For each file, provides flow-based reasoning that references directed paths, transitive dependencies, or how the file bridges importers to their transitive deps (not merely "it has N imports" or "N files depend on it")
Score 0 if the reasoning is purely based on import counts. Reply with just "1" or "0".`,
  },
];

// 5 general architecture tasks (regression detection)
const GENERAL_TASKS: EvalTask[] = [
  {
    id: "gen-1",
    category: "architecture",
    question:
      "Name one architectural weakness in this codebase that could be improved by extracting an interface. Identify the specific file and describe what the extracted interface would look like.",
    judgePrompt: `Score 1 if the answer:
1. Names a specific file from the codebase (e.g., graph.ts, utils.ts, types.ts, index.ts)
2. Describes a concrete interface that could be extracted (e.g., function signatures, data contracts, or module boundaries)
Score 0 if it's vague or doesn't name a specific file. Reply with just "1" or "0".`,
  },
  {
    id: "gen-2",
    category: "architecture",
    question:
      "Trace the import path you would follow to add a new language parser to this codebase. Name at least 3 intermediate files you would need to modify or extend, in the order they appear in the dependency chain.",
    judgePrompt: `Score 1 if the answer:
1. Names at least 3 real files from the codebase in a plausible dependency order
2. The path makes architectural sense (e.g., ast-parse.ts or detect.ts for parser registration, graph.ts for import resolution, types.ts for type definitions)
Score 0 if fewer than 3 files or the order is implausible. Reply with just "1" or "0".`,
  },
  {
    id: "gen-3",
    category: "architecture",
    question:
      "Which specific test file should you run first after modifying graph.ts? Use the test coverage map from the context to justify your answer.",
    judgePrompt: `Score 1 if the answer:
1. Names a specific test file (e.g., graph.test.ts, graph-algorithms.test.ts, or another test from the coverage map)
2. Justifies the choice by referencing the test coverage map or the relationship between graph.ts and the test
Score 0 if it just lists tests without justification. Reply with just "1" or "0".`,
  },
  {
    id: "gen-4",
    category: "architecture",
    question:
      "Name 2 files from the change coupling data that frequently change together. Is their coupling structural (direct import path exists) or hidden (no direct import, suggesting shared schema or duplicated logic)?",
    judgePrompt: `Score 1 if the answer:
1. Names 2 specific files that appear in the change coupling table
2. Correctly classifies their coupling as structural or hidden based on whether a direct import path exists between them
Score 0 if the files aren't from the coupling data or the classification is wrong. Reply with just "1" or "0".`,
  },
  {
    id: "gen-5",
    category: "architecture",
    question:
      "Explain the difference between an architectural chokepoint (whose removal disconnects the graph) and a flow bottleneck (that sits on many directed paths). Give one example of each from this codebase.",
    judgePrompt: `Score 1 if the answer:
1. Correctly distinguishes chokepoints (articulation points, graph disconnection) from flow bottlenecks (high directed betweenness, many transitive paths)
2. Names at least one specific example for each concept from the codebase
Score 0 if the distinction is wrong or no concrete examples are given. Reply with just "1" or "0".`,
  },
];

const TASKS: EvalTask[] = [...BOTTLENECK_TASKS, ...GENERAL_TASKS];

// ── Types ────────────────────────────────────────────────────────────────────

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
  directed: CallResult;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let client: Anthropic;
let baselineContext: string;
let directedContext: string;

function checkKeywords(answer: string, keywords: string[]): boolean {
  const lower = answer.toLowerCase();
  return keywords.every((kw) => lower.includes(kw.toLowerCase()));
}

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
        content: `You are an expert developer analyzing a codebase. Here is the project's CLAUDE.md context file:\n\n<context>\n${context}\n</context>\n\nAnswer this question concisely:\n${question}`,
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
  let totalInput = inputTokens;
  let totalOutput = outputTokens;

  let passed = false;

  if (task.requiredKeywords) {
    passed = checkKeywords(answer, task.requiredKeywords);
  } else if (task.judgePrompt) {
    const judge = await judgeAnswer(answer, task.judgePrompt);
    passed = judge.passed;
    totalInput += judge.inputTokens;
    totalOutput += judge.outputTokens;
  }

  return { answer, passed, inputTokens: totalInput, outputTokens: totalOutput };
}

// ── Report formatting ────────────────────────────────────────────────────────

function formatReport(results: TaskResult[], baselineBytes: number, directedBytes: number): string {
  const sep = "=".repeat(72);
  const lines: string[] = [];

  const baselineTokensEst = estimateTokens(baselineContext);
  const directedTokensEst = estimateTokens(directedContext);
  const sizeDelta = (((directedBytes - baselineBytes) / baselineBytes) * 100).toFixed(1);

  lines.push("");
  lines.push(sep);
  lines.push("  Directed Betweenness Experiment: Combo Eval Report (E.3-lite)");
  lines.push(sep);
  lines.push("");
  lines.push(`  Config: model=${MODEL}, temp=${TEMPERATURE}, iters=${N_ITERS}`);
  lines.push("");
  lines.push("  Context Sizes:");
  lines.push(
    `    Baseline (undirected): ${baselineBytes.toLocaleString()} bytes  (~${baselineTokensEst.toLocaleString()} tokens)`,
  );
  lines.push(
    `    Directed:              ${directedBytes.toLocaleString()} bytes  (~${directedTokensEst.toLocaleString()} tokens)`,
  );
  lines.push(`    Delta:                 ${sizeDelta}%`);
  lines.push("");

  // Per-iteration pass rates
  for (let iter = 0; iter < N_ITERS; iter++) {
    const iterResults = results.filter((r) => r.iteration === iter);
    const baselinePasses = iterResults.filter((r) => r.baseline.passed).length;
    const directedPasses = iterResults.filter((r) => r.directed.passed).length;
    const total = iterResults.length;
    const baselineRate = baselinePasses / total;
    const directedRate = directedPasses / total;
    const delta = directedRate - baselineRate;

    lines.push(`  Iteration ${iter + 1}:`);
    lines.push(`    Baseline: ${baselinePasses}/${total} (${(baselineRate * 100).toFixed(1)}%)`);
    lines.push(`    Directed: ${directedPasses}/${total} (${(directedRate * 100).toFixed(1)}%)`);
    lines.push(`    Delta:    ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`);
    lines.push("");
  }

  // Aggregate
  const baselinePasses = results.filter((r) => r.baseline.passed).length;
  const directedPasses = results.filter((r) => r.directed.passed).length;
  const total = results.length;
  const baselineRate = baselinePasses / total;
  const directedRate = directedPasses / total;
  const aggDelta = directedRate - baselineRate;

  lines.push("  Aggregate:");
  lines.push(`    Baseline: ${baselinePasses}/${total} (${(baselineRate * 100).toFixed(1)}%)`);
  lines.push(`    Directed: ${directedPasses}/${total} (${(directedRate * 100).toFixed(1)}%)`);
  lines.push(`    Delta:    ${aggDelta >= 0 ? "+" : ""}${(aggDelta * 100).toFixed(1)}%`);
  lines.push("");

  // Per-category breakdown
  const categories = [...new Set(TASKS.map((t) => t.category))];
  lines.push("  Per-Category:");
  lines.push(`    ${"Category".padEnd(16)} ${"Baseline".padEnd(10)} ${"Directed".padEnd(10)} Delta`);
  lines.push(`    ${"-".repeat(50)}`);
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    const catBaseline = catResults.filter((r) => r.baseline.passed).length;
    const catDirected = catResults.filter((r) => r.directed.passed).length;
    const catTotal = catResults.length;
    const catDelta = catDirected - catBaseline;
    const deltaStr = catDelta === 0 ? "  0" : catDelta > 0 ? ` +${catDelta}` : ` ${catDelta}`;
    lines.push(
      `    ${cat.padEnd(16)} ${catBaseline}/${catTotal}`.padEnd(32) +
        `${catDirected}/${catTotal}`.padEnd(10) +
        deltaStr,
    );
  }
  lines.push("");

  // Token usage
  const baselineInputTotal = results.reduce((a, r) => a + r.baseline.inputTokens, 0);
  const baselineOutputTotal = results.reduce((a, r) => a + r.baseline.outputTokens, 0);
  const directedInputTotal = results.reduce((a, r) => a + r.directed.inputTokens, 0);
  const directedOutputTotal = results.reduce((a, r) => a + r.directed.outputTokens, 0);
  const baselineCost = costFromTokens(baselineInputTotal, baselineOutputTotal);
  const directedCost = costFromTokens(directedInputTotal, directedOutputTotal);
  const totalCost = baselineCost + directedCost;

  lines.push("  Token Usage:");
  lines.push(
    `    Baseline: ${baselineInputTotal.toLocaleString()} in / ${baselineOutputTotal.toLocaleString()} out  ($${baselineCost.toFixed(3)})`,
  );
  lines.push(
    `    Directed: ${directedInputTotal.toLocaleString()} in / ${directedOutputTotal.toLocaleString()} out  ($${directedCost.toFixed(3)})`,
  );
  lines.push(`    Total:    $${totalCost.toFixed(3)}`);
  lines.push("");

  // Per-task detail
  lines.push("  Per-Task Detail:");
  lines.push(
    `    ${"Task".padEnd(10)} ${"Cat".padEnd(16)} ${"Iter".padEnd(6)} ${"Baseline".padEnd(10)} ${"Directed".padEnd(10)} Flip`,
  );
  lines.push(`    ${"-".repeat(62)}`);
  for (const r of results) {
    const bStr = r.baseline.passed ? "PASS" : "FAIL";
    const dStr = r.directed.passed ? "PASS" : "FAIL";
    let flip = "  -";
    if (r.baseline.passed && !r.directed.passed) flip = "  REGRESS";
    else if (!r.baseline.passed && r.directed.passed) flip = "  IMPROVE";
    lines.push(
      `    ${r.taskId.padEnd(10)} ${r.category.padEnd(16)} ${String(r.iteration + 1).padEnd(6)} ${bStr.padEnd(10)} ${dStr.padEnd(10)}${flip}`,
    );
  }
  lines.push("");

  // Verdict per iteration
  let allPass = true;
  let anyHardFail = false;
  for (let iter = 0; iter < N_ITERS; iter++) {
    const iterResults = results.filter((r) => r.iteration === iter);
    const bPass = iterResults.filter((r) => r.baseline.passed).length;
    const dPass = iterResults.filter((r) => r.directed.passed).length;
    const iterDelta = (dPass - bPass) / iterResults.length;
    if (iterDelta < -0.1) allPass = false;
    if (iterDelta < -0.15) anyHardFail = true;
  }

  const verdict = anyHardFail ? "FAIL" : allPass ? "PASS" : "MARGINAL";
  lines.push(`  Verdict: ${verdict}`);
  lines.push(`    PASS requires: delta >= -10% in all iterations`);
  lines.push(`    FAIL if: any iteration delta < -15%`);
  lines.push(sep);

  return lines.join("\n");
}

// ── Test ─────────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)("Directed Betweenness Combo Eval (E.3-lite)", () => {
  beforeAll(() => {
    client = new Anthropic();
    baselineContext = readFileSync("/tmp/clarte-undirected-claude.md", "utf-8");
    directedContext = readFileSync("/tmp/clarte-directed-claude.md", "utf-8");
  });

  it(`runs ${N_ITERS} iteration(s) of ${TASKS.length} tasks (temp=${TEMPERATURE})`, async () => {
    const results: TaskResult[] = [];

    for (let iter = 0; iter < N_ITERS; iter++) {
      console.log(`\n── Iteration ${iter + 1}/${N_ITERS} (temp=${TEMPERATURE}) ──`);

      for (const task of TASKS) {
        const [baselineResult, directedResult] = await Promise.all([
          scoreTask(baselineContext, task),
          scoreTask(directedContext, task),
        ]);

        results.push({
          taskId: task.id,
          category: task.category,
          iteration: iter,
          baseline: baselineResult,
          directed: directedResult,
        });

        const bIcon = baselineResult.passed ? "PASS" : "FAIL";
        const dIcon = directedResult.passed ? "PASS" : "FAIL";
        console.log(`  ${task.id.padEnd(8)} baseline=${bIcon}  directed=${dIcon}`);
      }
    }

    // Report
    const report = formatReport(
      results,
      Buffer.byteLength(baselineContext, "utf-8"),
      Buffer.byteLength(directedContext, "utf-8"),
    );
    console.log(report);

    // Assertions: check each iteration independently
    for (let iter = 0; iter < N_ITERS; iter++) {
      const iterResults = results.filter((r) => r.iteration === iter);
      const baselinePasses = iterResults.filter((r) => r.baseline.passed).length;
      const directedPasses = iterResults.filter((r) => r.directed.passed).length;
      const iterDelta = (directedPasses - baselinePasses) / iterResults.length;

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
      const directedPasses = iterResults.filter((r) => r.directed.passed).length;
      const iterDelta = (directedPasses - baselinePasses) / iterResults.length;

      expect(
        iterDelta,
        `Iteration ${iter + 1} delta ${(iterDelta * 100).toFixed(1)}% below non-inferiority gate (-10%)`,
      ).toBeGreaterThanOrEqual(-0.1);
    }
  }, 900_000); // 15 min timeout
});
