/**
 * E.1 Quick Eval Protocol -- Baseline capture and comparison.
 *
 * Runs the full analysis pipeline on benchmark fixtures and extracts
 * structured metrics for comparing experimental techniques against
 * the current (main) baseline.
 *
 * No LLM calls. Deterministic. Single-run GO/NO GO decisions.
 */

import {
  getHubFiles,
  computeInstability,
  detectArchitecturalLayers,
  findCircularDeps,
  findSCCs,
  findDeadFiles,
  findChokepoints,
  detectCommunities,
  findTightCouplings,
  findCrossCuttingFiles,
} from "../../graph.js";
import { buildSections } from "../../templates/main-context.js";
import { estimateTokens } from "../../utils.js";
import type { ContextAnalysis, DetectedContext, UserAnswers, CodeSnapshot, ContextSection } from "../../types.js";
import type { EvalFixture } from "./fixtures.js";
import { buildGraphFromFixture } from "./helpers.js";

// ── Types ────────────────────────────────────────────────────────────

/** Structured metrics extracted from a single fixture run. */
export interface BaselineMetrics {
  fixture: string;
  /** Total tokens in the rendered context (all sections). */
  totalTokens: number;
  /** Per-section token breakdown. */
  sectionTokens: Record<string, number>;
  /** Section IDs included (in priority order). */
  sectionsIncluded: string[];
  /** Section IDs omitted by budget. */
  sectionsOmitted: string[];
  /** Hub files in ranked order (by authority). */
  hubFiles: Array<{ path: string; authority: number; role: string; importedBy: number }>;
  /** Files flagged as high instability. */
  highInstabilityFiles: string[];
  /** Detected layers (in order). */
  layers: string[];
  /** Circular dependencies found. */
  cycles: string[][];
  /** Chokepoint files. */
  chokepoints: string[];
  /** Community count. */
  communityCount: number;
  /** Dead files. */
  deadFiles: string[];
  /** Tight coupling pairs. */
  tightCouplings: Array<{ fileA: string; fileB: string; importedNames: number }>;
  /** Number of working guideline directives. */
  directiveCount: number;
}

/** Side-by-side comparison of two metric sets. */
export interface MetricComparison {
  fixture: string;
  tokenDelta: number;
  tokenDeltaPct: number;
  directiveDelta: number;
  hubFilesMatch: boolean;
  hubFilesAdded: string[];
  hubFilesDropped: string[];
  chokepointsMatch: boolean;
  cyclesMatch: boolean;
  sectionsAdded: string[];
  sectionsDropped: string[];
  verdict: "GO" | "NO_GO" | "ITERATE";
  reasons: string[];
}

// ── Minimal mocks for template rendering ─────────────────────────────

/**
 * Create a minimal DetectedContext for a fixture.
 * Just enough for buildSections to work without filesystem access.
 */
function mockDetectedContext(fixture: EvalFixture): DetectedContext {
  const isPython = fixture.name.includes("python");
  return {
    rootDir: `/mock/${fixture.name}`,
    language: isPython ? "Python" : "TypeScript",
    hasTypeScript: !isPython,
    packageManager: isPython ? "pip" : "npm",
    linter: isPython ? "ruff" : "eslint",
    frameworks: [],
    directories: [...new Set(fixture.graph.files.map((f) => f.split("/")[0]))],
    dependencies: [],
    isGitRepo: false,
    totalSourceBytes: fixture.graph.files.length * 2000,
    sourceFileCount: fixture.graph.files.length,
    monorepo: null,
  };
}

/** Minimal UserAnswers for template rendering. */
function mockUserAnswers(): UserAnswers {
  return {
    ides: ["claude"],
    projectPurpose: "",
    keyPatterns: "",
    gotchas: "",
    generateSnapshot: false,
    snapshotPaths: [],
    stackConfirmed: true,
    stackCorrections: "",
    generatePerPackage: false,
  };
}

// ── Analysis pipeline ────────────────────────────────────────────────

/** Run the full analysis pipeline on a fixture and return ContextAnalysis. */
export function analyzeFixture(fixture: EvalFixture): ContextAnalysis {
  const graph = buildGraphFromFixture(fixture.graph.files, fixture.graph.edges);

  const hubFiles = getHubFiles(graph, fixture.graph.files.length);
  const circularDeps = findCircularDeps(graph, 20);
  const { layers, layerEdges } = detectArchitecturalLayers(graph);
  const instabilities = computeInstability(graph);
  const communities = detectCommunities(graph);
  const deadFiles = findDeadFiles(graph);
  const chokepoints = findChokepoints(graph);
  const tightCouplings = findTightCouplings(graph);
  const crossCuttingFiles = findCrossCuttingFiles(graph, layers);

  return {
    hubFiles,
    circularDeps,
    layers,
    layerEdges,
    gitActivity: null,
    instabilities,
    communities,
    deadFiles,
    chokepoints,
    tightCouplings: tightCouplings.length ? tightCouplings : undefined,
    crossCuttingFiles: crossCuttingFiles.length ? crossCuttingFiles : undefined,
  };
}

/** Run the full pipeline and extract structured metrics. */
export async function captureMetrics(
  fixture: EvalFixture,
  analysis?: ContextAnalysis,
  budget = 5000,
): Promise<BaselineMetrics> {
  const ctx = analysis ?? analyzeFixture(fixture);
  const detectedCtx = mockDetectedContext(fixture);
  const answers = mockUserAnswers();

  // Get all sections (unbudgeted) to measure per-section tokens
  const allSections = await buildSections(detectedCtx, answers, null, ctx);

  // Apply budget manually to get included/omitted split
  const sorted = [...allSections].sort((a, b) => a.priority - b.priority || b.tokens - a.tokens);
  let remaining = budget;
  const included: ContextSection[] = [];
  const omitted: string[] = [];

  for (const section of sorted) {
    if (section.priority <= 2 || remaining >= section.tokens) {
      included.push(section);
      remaining -= section.tokens;
    } else {
      omitted.push(section.id);
    }
  }

  const totalTokens = included.reduce((sum, s) => sum + s.tokens, 0);

  // Count directives from the working-guidelines section
  const guidelinesSection = allSections.find((s) => s.id === "working-guidelines");
  const directiveCount = guidelinesSection
    ? (guidelinesSection.content.match(/^- /gm) ?? []).length
    : 0;

  // Build section token map (all sections, not just included)
  const sectionTokens: Record<string, number> = {};
  for (const s of allSections) {
    sectionTokens[s.id] = s.tokens;
  }

  return {
    fixture: fixture.name,
    totalTokens,
    sectionTokens,
    sectionsIncluded: included.map((s) => s.id),
    sectionsOmitted: omitted,
    hubFiles: ctx.hubFiles.map((h) => ({
      path: h.path,
      authority: h.authority,
      role: h.role,
      importedBy: h.importedBy,
    })),
    highInstabilityFiles: ctx.instabilities.map((f) => f.path),
    layers: ctx.layers.map((l) => l.name),
    cycles: ctx.circularDeps.map((c) => c.chain),
    chokepoints: (ctx.chokepoints ?? []).map((c) => c.file),
    communityCount: ctx.communities.length,
    deadFiles: ctx.deadFiles ?? [],
    tightCouplings: (ctx.tightCouplings ?? []).map((tc) => ({
      fileA: tc.fileA,
      fileB: tc.fileB,
      importedNames: tc.importedNames.length,
    })),
    directiveCount,
  };
}

// ── Comparison ───────────────────────────────────────────────────────

/** Compare experimental metrics against a baseline. */
export function compareMetrics(
  baseline: BaselineMetrics,
  experimental: BaselineMetrics,
): MetricComparison {
  const reasons: string[] = [];

  // Token delta
  const tokenDelta = experimental.totalTokens - baseline.totalTokens;
  const tokenDeltaPct = baseline.totalTokens > 0
    ? (tokenDelta / baseline.totalTokens) * 100
    : 0;

  // Directive delta
  const directiveDelta = experimental.directiveCount - baseline.directiveCount;

  // Hub file comparison (top 10)
  const baselineHubs = new Set(baseline.hubFiles.slice(0, 10).map((h) => h.path));
  const experimentalHubs = new Set(experimental.hubFiles.slice(0, 10).map((h) => h.path));
  const hubFilesAdded = [...experimentalHubs].filter((h) => !baselineHubs.has(h));
  const hubFilesDropped = [...baselineHubs].filter((h) => !experimentalHubs.has(h));
  const hubFilesMatch = hubFilesAdded.length === 0 && hubFilesDropped.length === 0;

  // Chokepoint comparison
  const baselineChokepoints = new Set(baseline.chokepoints);
  const experimentalChokepoints = new Set(experimental.chokepoints);
  const chokepointsMatch =
    baselineChokepoints.size === experimentalChokepoints.size &&
    [...baselineChokepoints].every((c) => experimentalChokepoints.has(c));

  // Cycle comparison
  const baselineCycleKey = baseline.cycles.map((c) => c.sort().join(",")).sort().join(";");
  const experimentalCycleKey = experimental.cycles.map((c) => c.sort().join(",")).sort().join(";");
  const cyclesMatch = baselineCycleKey === experimentalCycleKey;

  // Section comparison
  const baselineSections = new Set(baseline.sectionsIncluded);
  const experimentalSections = new Set(experimental.sectionsIncluded);
  const sectionsAdded = [...experimentalSections].filter((s) => !baselineSections.has(s));
  const sectionsDropped = [...baselineSections].filter((s) => !experimentalSections.has(s));

  // Verdict logic
  let verdict: "GO" | "NO_GO" | "ITERATE" = "ITERATE";

  // Automatic NO GO: lost chokepoints or cycles
  if (!chokepointsMatch) {
    const lost = [...baselineChokepoints].filter((c) => !experimentalChokepoints.has(c));
    if (lost.length > 0) {
      reasons.push(`Lost chokepoints: ${lost.join(", ")}`);
      verdict = "NO_GO";
    }
  }
  if (!cyclesMatch) {
    reasons.push("Cycle detection changed");
  }

  // Check for improvements
  if (verdict !== "NO_GO") {
    const improvements: string[] = [];
    const regressions: string[] = [];

    if (tokenDeltaPct < -5) {
      improvements.push(`${Math.abs(tokenDeltaPct).toFixed(1)}% fewer tokens`);
    } else if (tokenDeltaPct > 10) {
      regressions.push(`${tokenDeltaPct.toFixed(1)}% more tokens`);
    }

    if (directiveDelta > 0) {
      improvements.push(`${directiveDelta} more directives`);
    } else if (directiveDelta < -2) {
      regressions.push(`${Math.abs(directiveDelta)} fewer directives`);
    }

    if (hubFilesDropped.length > 0) {
      regressions.push(`Lost hub files: ${hubFilesDropped.join(", ")}`);
    }

    if (sectionsDropped.length > 0) {
      regressions.push(`Lost sections: ${sectionsDropped.join(", ")}`);
    }

    if (regressions.length > 0 && improvements.length === 0) {
      verdict = "NO_GO";
      reasons.push(...regressions);
    } else if (improvements.length > 0 && regressions.length === 0) {
      verdict = "GO";
      reasons.push(...improvements);
    } else {
      verdict = "ITERATE";
      reasons.push(...improvements, ...regressions);
    }
  }

  // Default reason if none
  if (reasons.length === 0) {
    reasons.push("No measurable difference");
    verdict = "NO_GO";
  }

  return {
    fixture: baseline.fixture,
    tokenDelta,
    tokenDeltaPct,
    directiveDelta,
    hubFilesMatch,
    hubFilesAdded,
    hubFilesDropped,
    chokepointsMatch,
    cyclesMatch,
    sectionsAdded,
    sectionsDropped,
    verdict,
    reasons,
  };
}

/** Format a comparison as a readable report. */
export function formatComparison(c: MetricComparison): string {
  const lines: string[] = [];
  lines.push(`\n=== ${c.fixture} ===`);
  lines.push(`Verdict: ${c.verdict}`);
  lines.push(`Reasons: ${c.reasons.join("; ")}`);
  lines.push("");
  lines.push(`Tokens:      ${c.tokenDelta >= 0 ? "+" : ""}${c.tokenDelta} (${c.tokenDeltaPct >= 0 ? "+" : ""}${c.tokenDeltaPct.toFixed(1)}%)`);
  lines.push(`Directives:  ${c.directiveDelta >= 0 ? "+" : ""}${c.directiveDelta}`);
  lines.push(`Hub files:   ${c.hubFilesMatch ? "match" : `+${c.hubFilesAdded.length}/-${c.hubFilesDropped.length}`}`);
  lines.push(`Chokepoints: ${c.chokepointsMatch ? "match" : "CHANGED"}`);
  lines.push(`Cycles:      ${c.cyclesMatch ? "match" : "CHANGED"}`);
  if (c.sectionsAdded.length) lines.push(`Sections added:   ${c.sectionsAdded.join(", ")}`);
  if (c.sectionsDropped.length) lines.push(`Sections dropped: ${c.sectionsDropped.join(", ")}`);
  return lines.join("\n");
}
