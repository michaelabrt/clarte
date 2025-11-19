/**
 * Value-add eval: Does directed betweenness actually help?
 *
 * Tests on drizzle-orm, where flow bottleneck directives fire.
 * Compares agent performance with and without the flow bottleneck lines.
 *
 * Baseline: drizzle CLAUDE.md with flow bottleneck lines stripped
 * Directed: drizzle CLAUDE.md with flow bottleneck lines intact
 *
 * 5 tasks that test whether the extra information helps reasoning.
 * All tasks use judge scoring.
 *
 * Pre-generation: run `npm run build` then generate drizzle context:
 *   rm -rf /tmp/clarte-test-drizzle/.clarte
 *   echo n | node dist/index.js /tmp/clarte-test-drizzle --force
 *   cp /tmp/clarte-test-drizzle/CLAUDE.md /tmp/drizzle-directed.md
 *   grep -v "flow bottleneck" /tmp/drizzle-directed.md > /tmp/drizzle-baseline.md
 *
 * Run: LLM_EVAL=1 N_ITERS=3 npx vitest run src/__tests__/eval/betweenness-value-add-eval.test.ts
 * Cost: ~$1.50
 */

import { describe, it, expect, beforeAll } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "node:fs";

const SKIP =
  !process.env.LLM_EVAL ||
  !process.env.ANTHROPIC_API_KEY ||
  !existsSync("/tmp/drizzle-directed.md") ||
  !existsSync("/tmp/drizzle-baseline.md");

const N_ITERS = parseInt(process.env.N_ITERS ?? "3", 10);
const MODEL = "claude-sonnet-4-6";
const TEMPERATURE = 0.3;

const COST_PER_M_INPUT = 3.0;
const COST_PER_M_OUTPUT = 15.0;

// ── Tasks ────────────────────────────────────────────────────────────────────

interface EvalTask {
  id: string;
  question: string;
  judgePrompt: string;
}

const TASKS: EvalTask[] = [
  {
    id: "va-1",
    question:
      "Which files in drizzle-orm are flow bottlenecks -- files that sit on many directed import paths but are NOT structural chokepoints (articulation points)? Name them and explain why their position matters for refactoring risk.",
    judgePrompt: `Score 1 if the answer:
1. Names at least one of: drizzle-orm/src/column.ts, drizzle-orm/src/sql/sql.ts
2. Distinguishes flow bottlenecks from structural chokepoints (articulation points)
3. Explains why sitting on many directed paths creates refactoring risk
Score 0 if it cannot identify any flow bottleneck or conflates them with chokepoints. Reply with just "1" or "0".`,
  },
  {
    id: "va-2",
    question:
      "drizzle-orm/src/column.ts and drizzle-orm/src/column-builder.ts are both highly connected. But one is a structural chokepoint and the other is a flow bottleneck. Which is which, and what is the practical difference for a developer modifying these files?",
    judgePrompt: `Score 1 if the answer:
1. Correctly identifies column-builder.ts as the structural chokepoint (or at least associates it with graph disconnection)
2. Correctly identifies column.ts as the flow bottleneck (or at least associates it with many directed paths passing through it)
3. Explains a practical difference (e.g., removing a chokepoint disconnects the graph; modifying a bottleneck risks cascading changes along import chains)
Score 0 if both are labeled the same or the distinction is wrong. Reply with just "1" or "0".`,
  },
  {
    id: "va-3",
    question:
      "If I wanted to reduce the coupling risk around drizzle-orm/src/sql/sql.ts, what concrete refactoring would you suggest? Consider its role in the import graph when answering.",
    judgePrompt: `Score 1 if the answer:
1. References sql.ts's role as a bottleneck or high-traffic node in the import graph (not just "it has many imports")
2. Suggests a concrete refactoring (e.g., extracting an interface, splitting the module, introducing an abstraction layer)
3. The suggestion is grounded in the file's graph position, not generic advice
Score 0 if the advice is generic or doesn't reference the file's structural role. Reply with just "1" or "0".`,
  },
  {
    id: "va-4",
    question:
      "Looking at this codebase, which files would benefit most from being split into smaller modules? Rank the top 3 and justify each based on their position in the dependency graph, not just their size.",
    judgePrompt: `Score 1 if the answer:
1. Ranks at least 3 files
2. Justification references dependency graph position (e.g., "many paths pass through it", "bridges X to Y", "flow bottleneck") for at least 2 files
3. Includes at least one of: column.ts, sql.ts, column-builder.ts, snapshotsDiffer.ts
Score 0 if justification is purely size-based or doesn't reference graph structure. Reply with just "1" or "0".`,
  },
  {
    id: "va-5",
    question:
      "A new developer joins the drizzle team. Which 3 files should they understand first to grasp how data flows through the ORM layer? Consider import path centrality, not just documentation or naming.",
    judgePrompt: `Score 1 if the answer:
1. Names 3 files from drizzle-orm/src/
2. At least one is column.ts or sql/sql.ts (the flow bottlenecks)
3. Reasoning references how imports flow through these files, not just that they are "important" or "core"
Score 0 if the files are chosen purely by name/convention without flow reasoning. Reply with just "1" or "0".`,
  },
];

// ── Types ────────────────────────────────────────────────────────────────────

interface CallResult {
  answer: string;
  passed: boolean;
  inputTokens: number;
  outputTokens: number;
}

interface TaskResult {
  taskId: string;
  iteration: number;
  baseline: CallResult;
  directed: CallResult;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let client: Anthropic;
let baselineContext: string;
let directedContext: string;

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
          `You are an expert developer analyzing the drizzle-orm codebase. Here is the project's CLAUDE.md context file:\n\n<context>\n${context}\n</context>\n\nAnswer this question concisely:\n${question}`,
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

// ── Test ─────────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)("Directed Betweenness Value-Add Eval (drizzle)", () => {
  beforeAll(() => {
    client = new Anthropic();
    baselineContext = readFileSync("/tmp/drizzle-baseline.md", "utf-8");
    directedContext = readFileSync("/tmp/drizzle-directed.md", "utf-8");
  });

  it(`runs ${N_ITERS} iteration(s) of ${TASKS.length} value-add tasks (temp=${TEMPERATURE})`, async () => {
    const results: TaskResult[] = [];

    for (let iter = 0; iter < N_ITERS; iter++) {
      console.log(`\n-- Iteration ${iter + 1}/${N_ITERS} (temp=${TEMPERATURE}) --`);

      for (const task of TASKS) {
        const [baselineResult, directedResult] = await Promise.all([
          scoreTask(baselineContext, task),
          scoreTask(directedContext, task),
        ]);

        results.push({
          taskId: task.id,
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
    const sep = "=".repeat(72);
    const lines: string[] = [];
    lines.push("");
    lines.push(sep);
    lines.push("  Directed Betweenness Value-Add Eval (drizzle-orm)");
    lines.push(sep);
    lines.push("");
    lines.push(`  Config: model=${MODEL}, temp=${TEMPERATURE}, iters=${N_ITERS}`);
    lines.push(`  Context: baseline=${baselineContext.length} bytes, directed=${directedContext.length} bytes`);
    lines.push("");

    // Per-iteration
    for (let iter = 0; iter < N_ITERS; iter++) {
      const iterResults = results.filter((r) => r.iteration === iter);
      const bPass = iterResults.filter((r) => r.baseline.passed).length;
      const dPass = iterResults.filter((r) => r.directed.passed).length;
      const total = iterResults.length;
      const delta = (dPass - bPass) / total;
      lines.push(`  Iteration ${iter + 1}: baseline=${bPass}/${total}, directed=${dPass}/${total}, delta=${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(0)}%`);
    }
    lines.push("");

    // Aggregate
    const bTotal = results.filter((r) => r.baseline.passed).length;
    const dTotal = results.filter((r) => r.directed.passed).length;
    const total = results.length;
    const aggDelta = (dTotal - bTotal) / total;

    lines.push(`  Aggregate: baseline=${bTotal}/${total} (${(bTotal / total * 100).toFixed(0)}%), directed=${dTotal}/${total} (${(dTotal / total * 100).toFixed(0)}%)`);
    lines.push(`  Delta: ${aggDelta >= 0 ? "+" : ""}${(aggDelta * 100).toFixed(1)}%`);
    lines.push("");

    // Per-task detail
    lines.push("  Per-Task Detail:");
    lines.push(`    ${"Task".padEnd(8)} ${"Iter".padEnd(6)} ${"Baseline".padEnd(10)} ${"Directed".padEnd(10)} Flip`);
    lines.push(`    ${"-".repeat(50)}`);
    for (const r of results) {
      const bStr = r.baseline.passed ? "PASS" : "FAIL";
      const dStr = r.directed.passed ? "PASS" : "FAIL";
      let flip = "  -";
      if (r.baseline.passed && !r.directed.passed) flip = "  REGRESS";
      else if (!r.baseline.passed && r.directed.passed) flip = "  IMPROVE";
      lines.push(`    ${r.taskId.padEnd(8)} ${String(r.iteration + 1).padEnd(6)} ${bStr.padEnd(10)} ${dStr.padEnd(10)}${flip}`);
    }
    lines.push("");

    // Cost
    const bIn = results.reduce((a, r) => a + r.baseline.inputTokens, 0);
    const bOut = results.reduce((a, r) => a + r.baseline.outputTokens, 0);
    const dIn = results.reduce((a, r) => a + r.directed.inputTokens, 0);
    const dOut = results.reduce((a, r) => a + r.directed.outputTokens, 0);
    lines.push(`  Cost: $${(costFromTokens(bIn, bOut) + costFromTokens(dIn, dOut)).toFixed(3)}`);

    // Verdict
    const valueAdd = aggDelta > 0;
    lines.push("");
    lines.push(`  Value-add: ${valueAdd ? "YES" : "NO"} (directed delta: ${aggDelta >= 0 ? "+" : ""}${(aggDelta * 100).toFixed(1)}%)`);
    lines.push(sep);

    console.log(lines.join("\n"));

    // We don't assert a hard pass/fail here; this is informational.
    // But we do want to know the numbers.
    expect(results.length).toBe(N_ITERS * TASKS.length);
  }, 900_000);
});
