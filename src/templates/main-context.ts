import path from "node:path";
import type {
  ArchitecturalLayer,
  CodeSnapshot,
  ContextAnalysis,
  ContextSection,
  DetectedContext,
  IDETarget,
  ImportGraph,
  LayerEdge,
  UserAnswers,
} from "../types.js";
import { summarizeDetection } from "../detect.js";
import { estimateTokens, readJsonFile, readFileOr } from "../utils.js";
import { getFrameworkHintsSection } from "./framework-hints.js";
import { renderConstraintsSection } from "../config-scan.js";
import { renderConventionsSection } from "../conventions.js";
import { renderTestMappingSection } from "../test-map.js";
import { renderDirectivesSection } from "./directives.js";
import { findFeedbackEdges } from "../graph-cycles.js";

/** Default token budget for context files. */
export const DEFAULT_BUDGET = 5000;

/** Default character budget for context files (Claude Code warns above 40k). */
export const DEFAULT_MAX_CHARS = 39_500;

export interface SectionFilterOptions {
  /** Promote these section IDs to priority 0 (always included). */
  include?: Set<string>;
  /** Remove these section IDs entirely. */
  exclude?: Set<string>;
}

/**
 * Apply include/exclude filters to sections.
 * Exclude runs first (removes sections), then include promotes survivors to P0.
 */
function applyFilters(sections: ContextSection[], options?: SectionFilterOptions): ContextSection[] {
  let result = sections;

  if (options?.exclude?.size) {
    result = result.filter((s) => !options.exclude!.has(s.id));
  }

  if (options?.include?.size) {
    for (const s of result) {
      if (options.include.has(s.id)) {
        s.priority = 0;
      }
    }
  }

  return result;
}

/**
 * Build the main context file content (CLAUDE.md, AGENTS.md, or CONTEXT.md).
 * When budget > 0, sections are prioritized and trimmed to fit within the token budget.
 * Defaults to DEFAULT_BUDGET (5000 tokens) when budget is not specified.
 * Pass budget=0 (--full) to disable budgeting and include all sections.
 *
 * maxChars enforces a character ceiling (default: 39,500). Two-level strategy:
 *   1. Shrink the Code Snapshot section (trim lowest-value entries)
 *   2. Drop lowest-priority sections (P3+)
 * Pass maxChars=0 to disable character budgeting.
 * reservedChars accounts for user sections that will be merged after generation.
 */
export async function buildMainContext(
  ctx: DetectedContext,
  answers: UserAnswers,
  snapshot: CodeSnapshot | null,
  analysis?: ContextAnalysis,
  budget?: number,
  options?: SectionFilterOptions,
  maxChars?: number,
  reservedChars: number = 0,
  graph?: ImportGraph,
): Promise<string> {
  const allSections = await buildSections(ctx, answers, snapshot, analysis, graph);
  const effectiveBudget = budget ?? DEFAULT_BUDGET;
  const effectiveMaxChars = maxChars ?? DEFAULT_MAX_CHARS;

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const generatedComment = `\n<!-- clarte: generated ${timestamp}. Run npx clarte to regenerate. -->\n`;

  if (effectiveBudget <= 0) {
    // --full mode: include all sections, still apply filters
    const filtered = applyFilters(allSections, options);
    let result =
      filtered
        .map((s) => s.content)
        .join("\n\n")
        .trimEnd() +
      "\n" +
      generatedComment;

    // Apply character budget even in --full mode
    if (effectiveMaxChars > 0) {
      result = enforceCharBudget(filtered, result, effectiveMaxChars, reservedChars, generatedComment);
    }

    return result;
  }

  const filtered = applyFilters(allSections, options);
  const { included, omitted, overflowWarning } = applyBudget(filtered, effectiveBudget);
  let result =
    included
      .map((s) => s.content)
      .join("\n\n")
      .trimEnd() + "\n";

  if (overflowWarning) {
    result += `\n<!-- WARNING: ${overflowWarning} -->\n`;
  }
  if (omitted.length > 0) {
    result += `\n<!-- Sections omitted to fit token budget: ${omitted.join(", ")}. Run clarte --full for full output. -->\n`;
  }

  result += generatedComment;

  // Apply character budget after token budget
  if (effectiveMaxChars > 0) {
    result = enforceCharBudget(included, result, effectiveMaxChars, reservedChars, generatedComment);
  }

  return result;
}

/**
 * Build all context sections with priority and token estimates.
 * Exported for testing and programmatic use.
 */
export async function buildSections(
  ctx: DetectedContext,
  answers: UserAnswers,
  snapshot: CodeSnapshot | null,
  analysis?: ContextAnalysis,
  graph?: ImportGraph,
): Promise<ContextSection[]> {
  resetProjectNameCache();
  const projectName = await getProjectName(ctx);
  const stackSummary = answers.stackConfirmed
    ? summarizeDetection(ctx)
    : answers.stackCorrections || summarizeDetection(ctx);

  const sections: ContextSection[] = [];

  // -- Priority 0: Always included (header, what-is-this, key-patterns, gotchas, development) --

  // Header + maintenance directive
  const headerLines: string[] = [];
  headerLines.push(`# ${projectName}`);
  headerLines.push("");
  headerLines.push(
    "> **Keep this file up to date.** When you change the architecture, add a dependency, create a new pattern, or learn a gotcha, update this file in the same step. This is the source of truth for how the project works.",
  );
  headerLines.push(
    "> **This file is your starting point.** Only read additional files when the task requires implementation details not captured here.",
  );
  if (answers.ides.includes("cursor")) {
    headerLines.push("> Scoped rules are in `.cursor/rules/` -- update them when conventions change.");
  }
  const headerContent = headerLines.join("\n");
  sections.push({ id: "header", priority: 0, content: headerContent, tokens: estimateTokens(headerContent) });

  // What Is This (skip when projectPurpose is empty, e.g. zero-config runs)
  if (answers.projectPurpose) {
    const whatContent = `## What Is This\n\n${answers.projectPurpose}`;
    sections.push({ id: "what-is-this", priority: 0, content: whatContent, tokens: estimateTokens(whatContent) });
  }

  // -- Priority 1: Tech Stack, Config Constraints --

  const techContent = `## Tech Stack\n\n${buildTechStackSection(ctx, stackSummary)}`;
  sections.push({ id: "tech-stack", priority: 1, content: techContent, tokens: estimateTokens(techContent) });

  if (analysis?.configConstraints) {
    const constraintsSection = renderConstraintsSection(analysis.configConstraints);
    if (constraintsSection) {
      sections.push({
        id: "config-constraints",
        priority: 1,
        content: constraintsSection,
        tokens: estimateTokens(constraintsSection),
      });
    }
  }

  // -- Priority 2: Working Guidelines, Key Files --

  if (analysis) {
    const directivesSection = await renderDirectivesSection(analysis, ctx, graph);
    if (directivesSection) {
      sections.push({
        id: "working-guidelines",
        priority: 2,
        content: directivesSection,
        tokens: estimateTokens(directivesSection),
      });
    }
  }

  if (analysis?.hubFiles && analysis.hubFiles.length > 0) {
    const instabilityMap = new Map<string, number>();
    if (analysis.instabilities) {
      for (const inst of analysis.instabilities) {
        instabilityMap.set(inst.path, { instability: inst.instability, fanIn: inst.fanIn, fanOut: inst.fanOut });
      }
    }
    const keyLines: string[] = [];
    keyLines.push("## Key Files");
    keyLines.push("");
    keyLines.push("These are the most interconnected files. Read these first for architectural understanding.");
    keyLines.push("");
    keyLines.push("| File | Imported By | Stability |");
    keyLines.push("|------|-------------|-----------|");
    for (const hub of analysis.hubFiles) {
      const inst = instabilityMap.get(hub.path);
      const stabilityCell = inst != null ? `${(inst * 100).toFixed(0)}% unstable \u26A0\uFE0F` : "stable";
      const roleTag = hub.role !== "Leaf" ? ` (${hub.role})` : "";
      keyLines.push(
        `| \`${hub.path}\`${roleTag} | ${hub.importedBy} file${hub.importedBy === 1 ? "" : "s"} | ${stabilityCell} |`,
      );
    }
    const keyContent = keyLines.join("\n");
    sections.push({ id: "key-files", priority: 2, content: keyContent, tokens: estimateTokens(keyContent) });
  }

  // -- Priority 3: Circular Dependencies --

  if (analysis?.circularDeps && analysis.circularDeps.length > 0) {
    const circLines: string[] = [];
    circLines.push("## Circular Dependencies");
    circLines.push("");
    circLines.push("> These circular import chains may cause unexpected behavior when modified.");
    circLines.push("");
    for (const dep of analysis.circularDeps) {
      const severity =
        dep.severity != null ? (dep.severity === 0 ? " (type-only)" : dep.severity < 1 ? " (mixed)" : "") : "";
      const hint = dep.breakHint ? ` -- ${dep.breakHint}` : "";
      circLines.push(`- ${dep.chain.map((f) => `\`${f}\``).join(" -> ")}${severity}${hint}`);
    }

    // Add feedback edge suggestions when multiple cycles exist
    if (analysis.circularDeps.length > 1) {
      const feedbackEdges = findFeedbackEdges(analysis.circularDeps);
      if (feedbackEdges.length > 0) {
        circLines.push("");
        circLines.push("**Most impactful edges to break:**");
        for (const edge of feedbackEdges) {
          const shortFrom =
            edge.from
              .split("/")
              .pop()
              ?.replace(/\.[^.]+$/, "") ?? edge.from;
          const shortTo =
            edge.to
              .split("/")
              .pop()
              ?.replace(/\.[^.]+$/, "") ?? edge.to;
          circLines.push(
            `- Breaking \`${shortFrom}\` -> \`${shortTo}\` would resolve ${edge.cyclesResolved} of ${analysis.circularDeps.length} cycles`,
          );
        }
      }
    }
    const circContent = circLines.join("\n");
    sections.push({ id: "circular-deps", priority: 3, content: circContent, tokens: estimateTokens(circContent) });
  }

  // -- Priority 4: Architecture --

  if (analysis?.layers && analysis.layers.length > 1) {
    const archLines: string[] = [];
    archLines.push("## Architecture");
    archLines.push("");
    archLines.push(renderArchitectureDiagram(analysis.layers, analysis.layerEdges ?? []));
    const archContent = archLines.join("\n");
    sections.push({ id: "architecture", priority: 4, content: archContent, tokens: estimateTokens(archContent) });
  }

  // -- Priority 4: Package Dependencies (monorepo cross-package analysis) --

  if (analysis?.monorepoAnalysis && analysis.monorepoAnalysis.crossPackageEdges.length > 0) {
    const mono = analysis.monorepoAnalysis;
    const pkgLines: string[] = [];
    pkgLines.push("## Package Dependencies");
    pkgLines.push("");

    // Build summary table: group by (fromPackage, toPackage)
    const pairMap = new Map<string, { edges: number; violations: number }>();
    for (const edge of mono.crossPackageEdges) {
      const key = `${edge.fromPackage}|${edge.toPackage}`;
      const entry = pairMap.get(key) ?? { edges: 0, violations: 0 };
      entry.edges++;
      if (edge.isEncapsulationViolation) entry.violations++;
      pairMap.set(key, entry);
    }

    pkgLines.push("| From Package | To Package | Edges | Violations |");
    pkgLines.push("|-------------|------------|-------|------------|");
    for (const [key, val] of [...pairMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const [fromPkg, toPkg] = key.split("|");
      pkgLines.push(`| \`${fromPkg}\` | \`${toPkg}\` | ${val.edges} | ${val.violations} |`);
    }

    // Encapsulation violations as directives
    if (mono.encapsulationViolations.length > 0) {
      pkgLines.push("");
      pkgLines.push("### Encapsulation Violations");
      pkgLines.push("");
      for (const v of mono.encapsulationViolations.slice(0, 10)) {
        pkgLines.push(
          `- Import \`${v.toPackage}\` through its public API instead of importing internal file \`${v.to}\` directly (from \`${v.from}\`).`,
        );
      }
      if (mono.encapsulationViolations.length > 10) {
        pkgLines.push(`- ... and ${mono.encapsulationViolations.length - 10} more`);
      }
    }

    // Per-package top hub files
    if (mono.packageHubFiles && mono.packageHubFiles.size > 0) {
      pkgLines.push("");
      pkgLines.push("### Key Files by Package");
      pkgLines.push("");
      for (const [pkgName, hubFiles] of [...mono.packageHubFiles.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (hubFiles.length === 0) continue;
        pkgLines.push(`**${pkgName}**: ${hubFiles.map((f) => `\`${f.path}\``).join(", ")}`);
      }
    }

    const pkgContent = pkgLines.join("\n");
    sections.push({ id: "package-dependencies", priority: 4, content: pkgContent, tokens: estimateTokens(pkgContent) });
  }

  // -- Priority 5: Framework Hints, Conventions --

  const fwHints = getFrameworkHintsSection(ctx);
  if (fwHints) {
    sections.push({ id: "framework-hints", priority: 5, content: fwHints, tokens: estimateTokens(fwHints) });
  }

  if (analysis?.conventions) {
    const conventionsSection = renderConventionsSection(analysis.conventions);
    if (conventionsSection) {
      sections.push({
        id: "conventions",
        priority: 5,
        content: conventionsSection,
        tokens: estimateTokens(conventionsSection),
      });
    }
  }

  // -- Priority 6: Code Snapshot --

  if (snapshot?.markdown) {
    const snapLines: string[] = [];
    snapLines.push("## Code Snapshot");
    snapLines.push("");
    snapLines.push("<!-- CODE SNAPSHOT (auto-generated, update when types/stores/services change) -->");
    snapLines.push("");
    snapLines.push(snapshot.markdown);
    snapLines.push("");
    snapLines.push("<!-- /CODE SNAPSHOT -->");
    const snapContent = snapLines.join("\n");
    sections.push({ id: "code-snapshot", priority: 6, content: snapContent, tokens: estimateTokens(snapContent) });
  }

  // -- Priority 7: Hot Files, Change Coupling --

  if (analysis?.gitActivity && analysis.gitActivity.hotFiles.length > 0) {
    const hotLines: string[] = [];
    hotLines.push("## Recently Active Files");
    hotLines.push("");
    const days = analysis.analysisDays ?? 90;
    hotLines.push(`| File | Commits (${days}d) | Last Changed |`);
    hotLines.push("|------|--------------|--------------|");
    for (const hot of analysis.gitActivity.hotFiles.slice(0, 10)) {
      hotLines.push(`| \`${hot.path}\` | ${hot.commits} | ${hot.lastChanged} |`);
    }
    const hotContent = hotLines.join("\n");
    sections.push({ id: "hot-files", priority: 7, content: hotContent, tokens: estimateTokens(hotContent) });
  }

  if (analysis?.gitActivity?.changeCoupling && analysis.gitActivity.changeCoupling.length > 0) {
    const ccLines: string[] = [];
    ccLines.push("## Change Coupling");
    ccLines.push("");
    ccLines.push("Files that frequently change together -- when modifying one, check if the other needs updates too.");
    ccLines.push("");
    ccLines.push("| File A | File B | Co-changes | Jaccard |");
    ccLines.push("|--------|--------|------------|---------|");
    for (const pair of analysis.gitActivity.changeCoupling) {
      ccLines.push(
        `| \`${pair.fileA}\` | \`${pair.fileB}\` | ${pair.coChangeCount} | ${(pair.confidence * 100).toFixed(0)}% |`,
      );
    }
    const ccContent = ccLines.join("\n");
    sections.push({ id: "change-coupling", priority: 7, content: ccContent, tokens: estimateTokens(ccContent) });
  }

  // -- Priority 8: Test Mapping, Structure --

  if (analysis?.testMapping) {
    const testSection = renderTestMappingSection(analysis.testMapping, analysis.hubFiles);
    if (testSection) {
      sections.push({ id: "test-mapping", priority: 8, content: testSection, tokens: estimateTokens(testSection) });
    }
  }

  if (ctx.directories.length > 0) {
    const structLines: string[] = [];
    structLines.push("## Project Structure");
    structLines.push("");
    structLines.push("```");
    structLines.push(buildStructureTree(ctx));
    structLines.push("```");
    const structContent = structLines.join("\n");
    sections.push({ id: "structure", priority: 8, content: structContent, tokens: estimateTokens(structContent) });
  }

  // Monorepo structure (same priority as structure)
  if (ctx.monorepo && ctx.monorepo.packages.length > 0) {
    const monoLines: string[] = [];
    monoLines.push("## Monorepo Structure");
    monoLines.push("");
    monoLines.push(`${ctx.monorepo.type} workspace with ${ctx.monorepo.packages.length} packages:`);
    monoLines.push("");
    for (const pkg of ctx.monorepo.packages) {
      const fws = pkg.frameworks.length > 0 ? ` (${pkg.frameworks.map((f) => f.name).join(", ")})` : "";
      monoLines.push(`- **${pkg.name}** (\`${pkg.path}\`)${fws}`);
    }
    const monoContent = monoLines.join("\n");
    sections.push({ id: "monorepo-structure", priority: 8, content: monoContent, tokens: estimateTokens(monoContent) });
  }

  // -- Priority 9: Dead Files, Cross-Cutting, Chokepoints --

  if (analysis?.deadFiles && analysis.deadFiles.length > 0) {
    const deadLines: string[] = [];
    deadLines.push("## Dead Files");
    deadLines.push("");
    deadLines.push("Files not imported by any other source file. Candidates for removal or missing entry points.");
    deadLines.push("");
    for (const file of analysis.deadFiles.slice(0, 15)) {
      deadLines.push(`- \`${file}\``);
    }
    if (analysis.deadFiles.length > 15) {
      deadLines.push(`- ... and ${analysis.deadFiles.length - 15} more`);
    }
    const deadContent = deadLines.join("\n");
    sections.push({ id: "dead-files", priority: 9, content: deadContent, tokens: estimateTokens(deadContent) });
  }

  if (analysis?.crossCuttingFiles && analysis.crossCuttingFiles.length > 0) {
    const ccfLines: string[] = [];
    ccfLines.push("## Cross-Cutting Files");
    ccfLines.push("");
    ccfLines.push(
      "These files are imported across multiple architectural layers. Changes here have wide blast radius.",
    );
    ccfLines.push("");
    ccfLines.push("| File | Imported By | Layers |");
    ccfLines.push("|------|------------|--------|");
    for (const f of analysis.crossCuttingFiles) {
      ccfLines.push(
        `| \`${f.file}\` | ${f.totalImporters} file${f.totalImporters === 1 ? "" : "s"} | ${f.layers.join(", ")} |`,
      );
    }
    const ccfContent = ccfLines.join("\n");
    sections.push({ id: "cross-cutting", priority: 9, content: ccfContent, tokens: estimateTokens(ccfContent) });
  }

  if (analysis?.chokepoints && analysis.chokepoints.length > 0) {
    const cpLines: string[] = [];
    cpLines.push("## Architectural Chokepoints");
    cpLines.push("");
    cpLines.push("Files whose removal would disconnect parts of the codebase. Refactor with extreme care.");
    cpLines.push("");
    cpLines.push("| File | Separates | Imported By |");
    cpLines.push("|------|-----------|-------------|");
    for (const cp of analysis.chokepoints.slice(0, 10)) {
      cpLines.push(
        `| \`${cp.file}\` | ${cp.separates} component${cp.separates === 1 ? "" : "s"} | ${cp.importedBy} file${cp.importedBy === 1 ? "" : "s"} |`,
      );
    }
    const cpContent = cpLines.join("\n");
    sections.push({ id: "chokepoints", priority: 9, content: cpContent, tokens: estimateTokens(cpContent) });
  }

  // -- Priority 10: Tight Coupling, Hidden Coupling, Layer Consistency --

  if (analysis?.tightCouplings && analysis.tightCouplings.length > 0) {
    const tcLines: string[] = [];
    tcLines.push("## Tight Coupling");
    tcLines.push("");
    tcLines.push(
      "File pairs where one file imports many named exports from another, indicating strong coupling. Consider an intermediate interface if refactoring.",
    );
    tcLines.push("");
    for (const tc of analysis.tightCouplings) {
      tcLines.push(`- \`${tc.from}\` imports ${tc.importedNames} names from \`${tc.to}\``);
    }
    const tcContent = tcLines.join("\n");
    sections.push({ id: "tight-coupling", priority: 10, content: tcContent, tokens: estimateTokens(tcContent) });
  }

  if (analysis?.structuralMismatches && analysis.structuralMismatches.length > 0) {
    const smLines: string[] = [];
    smLines.push("## Hidden Coupling");
    smLines.push("");
    smLines.push(
      "File pairs that frequently change together but have no direct import path. These suggest hidden dependencies (shared schema, duplicated logic, or a missing shared module).",
    );
    smLines.push("");
    smLines.push("| File A | File B | Co-changes | Confidence | Graph Distance |");
    smLines.push("|--------|--------|------------|------------|----------------|");
    for (const m of analysis.structuralMismatches) {
      const dist = m.graphDistance === -1 ? "unreachable" : `${m.graphDistance} hops`;
      smLines.push(
        `| \`${m.fileA}\` | \`${m.fileB}\` | ${m.coChangeCount} | ${Math.round(m.coChangeConfidence * 100)}% | ${dist} |`,
      );
    }
    const smContent = smLines.join("\n");
    sections.push({ id: "hidden-coupling", priority: 10, content: smContent, tokens: estimateTokens(smContent) });
  }

  if (analysis?.layerConsistency && analysis.layers && analysis.layers.length > 1) {
    const lc = analysis.layerConsistency;
    if (lc.violations.length > 0) {
      const lcLines: string[] = [];
      lcLines.push("## Layer Consistency");
      lcLines.push("");
      lcLines.push(`Dependency direction consistency: ${(lc.consistency * 100).toFixed(0)}% (imports flow downward)`);
      lcLines.push("");
      lcLines.push("Violations (imports flowing upward):");
      lcLines.push("");
      for (const v of lc.violations.slice(0, 5)) {
        lcLines.push(`- \`${v.from}\` imports from \`${v.to}\` (${v.fromLayer} -> ${v.toLayer})`);
      }
      if (lc.violations.length > 5) {
        lcLines.push(`- ... and ${lc.violations.length - 5} more`);
      }
      const lcContent = lcLines.join("\n");
      sections.push({ id: "layer-consistency", priority: 10, content: lcContent, tokens: estimateTokens(lcContent) });
    }
  }

  // -- Priority 0: Key Patterns, Gotchas, Development (always included) --

  if (answers.keyPatterns) {
    const patLines: string[] = [];
    patLines.push("## Key Patterns");
    patLines.push("");
    const patterns = answers.keyPatterns
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of patterns) {
      patLines.push(`- ${p}`);
    }
    const patContent = patLines.join("\n");
    sections.push({ id: "key-patterns", priority: 0, content: patContent, tokens: estimateTokens(patContent) });
  }

  if (answers.gotchas) {
    const gotLines: string[] = [];
    gotLines.push("## Gotchas");
    gotLines.push("");
    const gotchas = answers.gotchas
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const g of gotchas) {
      gotLines.push(`- ${g}`);
    }
    const gotContent = gotLines.join("\n");
    sections.push({ id: "gotchas", priority: 0, content: gotContent, tokens: estimateTokens(gotContent) });
  }

  const devContent = `## Development\n\n${await buildDevSection(ctx)}`;
  sections.push({ id: "development", priority: 0, content: devContent, tokens: estimateTokens(devContent) });

  // -- Per-IDE section priority boosts (Task 1c) --
  // Only apply when a single IDE is targeted.
  if (answers.ides.length === 1) {
    const ide = answers.ides[0];
    if (ide === "claude") {
      applySectionBoost(sections, "working-guidelines", 1);
      applySectionBoost(sections, "config-constraints", 1);
    } else if (ide === "cursor") {
      applySectionBoost(sections, "architecture", 2);
    } else if (ide === "copilot") {
      applySectionBoost(sections, "conventions", 2);
      applySectionBoost(sections, "code-snapshot", 3);
    }
  }

  // -- User-controlled section ordering (Task 1a) --
  const sectionOrder = answers.sectionOrder;
  if (sectionOrder && Array.isArray(sectionOrder) && sectionOrder.length > 0) {
    const excludeSet = new Set<string>();
    const orderList: string[] = [];

    for (const entry of sectionOrder) {
      if (entry.startsWith("-")) {
        excludeSet.add(entry.slice(1));
      } else {
        orderList.push(entry);
      }
    }

    // Remove excluded sections
    for (let i = sections.length - 1; i >= 0; i--) {
      if (excludeSet.has(sections[i].id)) {
        sections.splice(i, 1);
      }
    }

    // Re-assign priorities based on array position for ordered sections.
    // Sections not in the list keep their default priority but are offset
    // so they appear after all explicitly ordered sections.
    const maxOrderedPriority = orderList.length;
    for (const section of sections) {
      const idx = orderList.indexOf(section.id);
      if (idx !== -1) {
        section.priority = idx;
      } else {
        // Offset non-listed sections so they sort after the ordered ones
        section.priority = maxOrderedPriority + section.priority;
      }
    }
  }

  return sections;
}

/**
 * Boost a section's priority if the section exists.
 */
function applySectionBoost(sections: ContextSection[], id: string, priority: number): void {
  const section = sections.find((s) => s.id === id);
  if (section && section.priority > priority) {
    section.priority = priority;
  }
}

/**
 * Apply a token budget to sections, including by priority order.
 * Priority 0 sections are always included.
 */
export function applyBudget(
  sections: ContextSection[],
  budget: number,
): { included: ContextSection[]; omitted: string[]; overflowWarning?: string } {
  // Priority 0 is always included
  const always = sections.filter((s) => s.priority === 0);
  const budgeted = sections.filter((s) => s.priority > 0);

  // Sort by priority (ascending = highest priority first)
  budgeted.sort((a, b) => a.priority - b.priority);

  let remaining = budget;
  for (const s of always) {
    remaining -= s.tokens;
  }

  const included: ContextSection[] = [...always];
  const omitted: string[] = [];

  // Priority 1-2 are always included (even if over budget)
  for (const s of budgeted) {
    if (s.priority <= 2) {
      included.push(s);
      remaining -= s.tokens;
    } else if (remaining >= s.tokens) {
      included.push(s);
      remaining -= s.tokens;
    } else {
      omitted.push(s.id);
    }
  }

  // Restore original order by re-sorting based on position in the original array
  const orderMap = new Map(sections.map((s, i) => [s.id, i]));
  included.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));

  // Check for budget overflow: mandatory sections (p0-2) exceed the budget
  const mandatoryTokens = included.filter((s) => s.priority <= 2).reduce((sum, s) => sum + s.tokens, 0);
  let overflowWarning: string | undefined;
  if (mandatoryTokens > budget) {
    overflowWarning = `Mandatory sections (priority 0-2) use ~${mandatoryTokens} tokens, exceeding the ${budget}-token budget. Consider increasing --budget or reducing project scope.`;
  }

  return { included, omitted, overflowWarning };
}

/**
 * Enforce a character budget on the fully-assembled output.
 * Two-level strategy:
 *   1. Shrink the Code Snapshot (trim lowest-value entries via binary search)
 *   2. Drop lowest-priority sections (P3+), highest priority number first
 *
 * Returns the (possibly trimmed) result string.
 */
function enforceCharBudget(
  sections: ContextSection[],
  result: string,
  maxChars: number,
  reservedChars: number,
  generatedComment: string,
): string {
  const available = maxChars - reservedChars;
  if (result.length <= available) return result;

  // Level 1: Try shrinking the code-snapshot section
  const snapSection = sections.find((s) => s.id === "code-snapshot");
  if (snapSection) {
    const overshoot = result.length - available;
    const targetSnapChars = Math.max(0, snapSection.content.length - overshoot);

    // Parse snapshot entries from the section content
    // The section wraps the markdown between CODE SNAPSHOT markers
    const snapshotStart = "<!-- CODE SNAPSHOT (auto-generated, update when types/stores/services change) -->";
    const snapshotEnd = "<!-- /CODE SNAPSHOT -->";
    const startIdx = snapSection.content.indexOf(snapshotStart);
    const endIdx = snapSection.content.indexOf(snapshotEnd);

    if (startIdx >= 0 && endIdx >= 0) {
      const prefix = snapSection.content.slice(0, startIdx + snapshotStart.length + 1);
      const suffix = "\n" + snapSection.content.slice(endIdx);
      const wrapperChars = prefix.length + suffix.length;
      const targetMarkdownChars = Math.max(100, targetSnapChars - wrapperChars);

      // We need access to the snapshot entries. Re-import is not possible here,
      // so we use a simpler approach: progressively remove lines from the end
      // of the markdown block until it fits.
      const snapshotMarkdown = snapSection.content.slice(startIdx + snapshotStart.length + 1, endIdx).trim();
      const trimmedMarkdown = trimMarkdownToChars(snapshotMarkdown, targetMarkdownChars);

      if (trimmedMarkdown.length < snapshotMarkdown.length) {
        const newSnapContent = prefix + trimmedMarkdown + "\n" + suffix.trimStart();
        const newResult = result.replace(snapSection.content, newSnapContent);

        if (newResult.length <= available) {
          // Add omission comment so the user knows the snapshot was trimmed
          const trimComment = `\n<!-- Sections omitted to fit char budget: code-snapshot (trimmed). Run clarte --full for full output. -->\n`;
          return newResult.replace(generatedComment, trimComment + generatedComment);
        }
        // Partially helped; continue with section dropping
        result = newResult;
        snapSection.content = newSnapContent;
      }
    }
  }

  // Level 2: Drop lowest-priority sections (highest priority number first, P3+)
  const { included: charIncluded, dropped } = applyCharBudget(sections, available, generatedComment);
  let charResult =
    charIncluded
      .map((s) => s.content)
      .join("\n\n")
      .trimEnd() + "\n";
  if (dropped.length > 0) {
    charResult += `\n<!-- Sections omitted to fit char budget: ${dropped.join(", ")}. Run clarte --full for full output. -->\n`;
  }
  charResult += generatedComment;
  return charResult;
}

/**
 * Trim a markdown code snapshot by removing entries from the end.
 * Entries are separated by blank lines within code blocks.
 * This is a character-level trim, not entry-level.
 */
function trimMarkdownToChars(markdown: string, maxChars: number): string {
  if (markdown.length <= maxChars) return markdown;

  let result = markdown;

  // Recompute section starts from current result on each pass
  const findSectionStarts = (text: string): number[] => {
    const starts: number[] = [];
    let from = 0;
    while (true) {
      const idx = text.indexOf("### ", from);
      if (idx < 0) break;
      starts.push(idx);
      from = idx + 4;
    }
    return starts;
  };

  // Remove entries from the last section first, working backwards
  let changed = true;
  while (changed && result.length > maxChars) {
    changed = false;
    const sectionStarts = findSectionStarts(result);

    for (let si = sectionStarts.length - 1; si >= 0 && result.length > maxChars; si--) {
      const secStart = sectionStarts[si];
      const secEnd = si + 1 < sectionStarts.length ? sectionStarts[si + 1] : result.length;
      const secContent = result.slice(secStart, secEnd);

      // Find the code block within this section
      const codeStart = secContent.indexOf("```");
      if (codeStart < 0) continue;
      const codeEnd = secContent.indexOf("\n```", codeStart + 3);
      if (codeEnd < 0) continue;

      const codeBlock = secContent.slice(codeStart, codeEnd + 4);
      // Split code block entries by double newlines
      const firstNewline = codeBlock.indexOf("\n");
      const fence = codeBlock.slice(0, firstNewline + 1);
      const closeFence = "\n```";
      const codeBody = codeBlock.slice(firstNewline + 1, codeBlock.length - 4);
      const entries = codeBody.split("\n\n");

      if (entries.length > 1) {
        // Remove one entry and restart (section offsets change after mutation)
        entries.pop();
        const newCodeBlock = fence + entries.join("\n\n") + closeFence;
        const newSecContent = secContent.slice(0, codeStart) + newCodeBlock + secContent.slice(codeEnd + 4);
        result = result.slice(0, secStart) + newSecContent + result.slice(secEnd);
        changed = true;
        break; // Restart with fresh section offsets
      }

      // If section is now empty (only fence), remove the entire section
      if (entries.length <= 1 && entries[0]?.trim() === "") {
        result = result.slice(0, secStart) + result.slice(secEnd);
        changed = true;
        break; // Restart with fresh section offsets
      }
    }
  }

  return result;
}

/**
 * Drop lowest-priority sections to fit within a character budget.
 * Never drops P0-2 sections. Drops highest priority number first.
 */
export function applyCharBudget(
  sections: ContextSection[],
  maxChars: number,
  generatedComment: string,
): { included: ContextSection[]; dropped: string[] } {
  // Start with all sections
  const sorted = [...sections].sort((a, b) => a.priority - b.priority);
  const _mandatory = sorted.filter((s) => s.priority <= 2);
  const droppable = sorted.filter((s) => s.priority > 2).reverse(); // highest priority number first

  const included = [...sorted];
  const dropped: string[] = [];

  // Compute total size incrementally instead of O(n) string rebuild on each drop
  let totalChars = included.reduce((sum, s) => sum + s.content.trimEnd().length, 0)
    + (included.length > 1 ? (included.length - 1) * 2 : 0) // "\n\n" separators
    + 1 + generatedComment.length;

  while (totalChars > maxChars && droppable.length > 0) {
    const toDrop = droppable.shift()!;
    const idx = included.findIndex((s) => s.id === toDrop.id);
    if (idx >= 0) {
      totalChars -= toDrop.content.trimEnd().length;
      if (included.length > 1) totalChars -= 2; // remove one "\n\n" separator
      included.splice(idx, 1);
      dropped.push(toDrop.id);
    }
  }

  // Restore original order
  const orderMap = new Map(sections.map((s, i) => [s.id, i]));
  included.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));

  return { included, dropped };
}

/**
 * Render a compact architecture diagram showing dependency flow.
 */
function renderArchitectureDiagram(layers: ArchitecturalLayer[], layerEdges: LayerEdge[]): string {
  const layerNames = layers.map((l) => `\`${l.name}\``);
  const lines: string[] = [];

  lines.push("Dependency flow (foundational -> consumer):");
  lines.push("");
  lines.push(layerNames.join(" -> "));

  const mainFlow = new Set<string>();
  for (let i = 0; i < layers.length - 1; i++) {
    mainFlow.add(`${layers[i].name}->${layers[i + 1].name}`);
  }
  const crossEdges = layerEdges.filter((e) => !mainFlow.has(`${e.from}->${e.to}`));
  if (crossEdges.length > 0) {
    lines.push("");
    lines.push("Cross-layer edges: " + crossEdges.map((e) => `${e.from} -> ${e.to}`).join(", "));
  }

  return lines.join("\n");
}

// Cache for getProjectName to avoid redundant filesystem reads within a single
// generation. Ideally the project name would be threaded through
// DetectedContext.projectName, but types.ts is owned by another worker.
let _projectNameCache: { rootDir: string; name: string } | null = null;

async function getProjectName(ctx: DetectedContext): Promise<string> {
  // Return cached result if available for the same rootDir
  if (_projectNameCache && _projectNameCache.rootDir === ctx.rootDir) {
    return _projectNameCache.name;
  }

  let name: string | null = null;

  const pkg = await readJsonFile(path.join(ctx.rootDir, "package.json"));
  if (pkg?.name && typeof pkg.name === "string") {
    name = pkg.name;
  }

  if (!name) {
    const cargo = await readFileOr(path.join(ctx.rootDir, "Cargo.toml"));
    if (cargo) {
      const match = cargo.match(/^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m);
      if (match) name = match[1];
    }
  }

  if (!name) {
    const gomod = await readFileOr(path.join(ctx.rootDir, "go.mod"));
    if (gomod) {
      const match = gomod.match(/^module\s+(\S+)/m);
      if (match) {
        const parts = match[1].split("/");
        name = parts[parts.length - 1];
      }
    }
  }

  if (!name) {
    const pyproject = await readFileOr(path.join(ctx.rootDir, "pyproject.toml"));
    if (pyproject) {
      const match = pyproject.match(/^\[project\][\s\S]*?^name\s*=\s*"([^"]+)"/m);
      if (match) name = match[1];
    }
  }

  if (!name) {
    const dirName = ctx.rootDir.split("/").pop() ?? "Project";
    name = dirName.charAt(0).toUpperCase() + dirName.slice(1);
  }

  _projectNameCache = { rootDir: ctx.rootDir, name };
  return name;
}

/**
 * Reset the project name cache. Called at the start of buildSections()
 * to ensure fresh results per generation run.
 * Exported for testing.
 */
export function resetProjectNameCache(): void {
  _projectNameCache = null;
}

function buildTechStackSection(ctx: DetectedContext, summary: string): string {
  const lines: string[] = [];

  if (ctx.frameworks.length > 0) {
    for (const fw of ctx.frameworks) {
      const ver = fw.version ? ` ${fw.version}` : "";
      const usage =
        fw.importCount != null
          ? fw.importCount === 0
            ? " (config-only)"
            : ` (used in ${fw.importCount} file${fw.importCount === 1 ? "" : "s"})`
          : "";
      lines.push(`- **${fw.name}**${ver}${usage}`);
    }
  }

  if (ctx.hasTypeScript) {
    lines.push("- **TypeScript**");
  }

  if (ctx.linter !== "none") {
    const name = ctx.linter.charAt(0).toUpperCase() + ctx.linter.slice(1);
    lines.push(`- **${name}** (linter/formatter)`);
  }

  if (ctx.packageManager !== "none") {
    lines.push(`- **${ctx.packageManager}** (package manager)`);
  }

  if (lines.length === 0) {
    lines.push(`Stack: ${summary}`);
  }

  return lines.join("\n");
}

function buildStructureTree(ctx: DetectedContext): string {
  const lines: string[] = [];
  const grouped = new Map<string, string[]>();

  for (const dir of ctx.directories) {
    const parts = dir.split("/");
    if (parts.length === 1) {
      if (!grouped.has(dir)) grouped.set(dir, []);
    } else {
      const parent = parts[0];
      const child = parts.slice(1).join("/");
      const children = grouped.get(parent) ?? [];
      children.push(child);
      grouped.set(parent, children);
    }
  }

  for (const [dir, children] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${dir}/`);
    for (const child of [...children].sort()) {
      lines.push(`  ${child}/`);
    }
  }

  return lines.join("\n");
}

async function buildDevSection(ctx: DetectedContext): Promise<string> {
  const lines: string[] = [];

  const pkg = await readJsonFile(path.join(ctx.rootDir, "package.json"));
  const scripts = (pkg?.scripts as Record<string, string> | undefined) ?? {};

  const runPrefix = (script: string) => {
    switch (ctx.packageManager) {
      case "pnpm":
        return `pnpm ${script}`;
      case "yarn":
        return `yarn ${script}`;
      case "bun":
        return `bun run ${script}`;
      case "npm":
        return `npm run ${script}`;
      default:
        return `npm run ${script}`;
    }
  };

  const installCmd = (() => {
    switch (ctx.packageManager) {
      case "pnpm":
        return "pnpm install";
      case "yarn":
        return "yarn install";
      case "bun":
        return "bun install";
      case "npm":
        return "npm install";
      default:
        return null;
    }
  })();

  switch (ctx.packageManager) {
    case "pnpm":
    case "yarn":
    case "bun":
    case "npm": {
      lines.push("```bash");
      if (installCmd) lines.push(installCmd);
      const devScript = scripts.dev ? "dev" : scripts.start ? "start" : scripts.serve ? "serve" : null;
      if (devScript) lines.push(runPrefix(devScript));
      lines.push("```");

      if (scripts.test) {
        lines.push("");
        lines.push("```bash");
        lines.push(runPrefix("test"));
        lines.push("```");
      }
      if (scripts.build) {
        lines.push("");
        lines.push("```bash");
        lines.push(runPrefix("build"));
        lines.push("```");
      }
      break;
    }
    case "pip":
    case "poetry": {
      const poetryPrefix = ctx.packageManager === "poetry" ? "poetry run " : "";
      lines.push("```bash");
      lines.push(ctx.packageManager === "poetry" ? "poetry install" : "pip install -r requirements.txt");

      // Framework-aware dev commands
      const fwNames = ctx.frameworks.map((f) => f.name);
      if (fwNames.includes("Django")) {
        lines.push(`${poetryPrefix}python manage.py runserver`);
      } else if (fwNames.includes("FastAPI")) {
        lines.push(`${poetryPrefix}uvicorn app.main:app --reload`);
      } else if (fwNames.includes("Flask")) {
        lines.push(`${poetryPrefix}flask run`);
      }

      lines.push("```");

      // pytest test command
      if (fwNames.includes("pytest")) {
        lines.push("");
        lines.push("```bash");
        lines.push(`${poetryPrefix}pytest`);
        lines.push("```");
      }
      break;
    }
    case "cargo":
      lines.push("```bash");
      lines.push("cargo build");
      lines.push("cargo run");
      lines.push("```");
      break;
    case "go":
      lines.push("```bash");
      lines.push("go build ./...");
      lines.push("go run .");
      lines.push("```");
      break;
    default:
      lines.push("(add your build/run commands here)");
  }

  if (ctx.linter !== "none") {
    lines.push("");
    lines.push(`Linter: **${ctx.linter}**`);
  }

  return lines.join("\n");
}

/**
 * Get the filename for the main context file based on IDE target.
 */
export function getMainContextFilename(ide: IDETarget): string {
  switch (ide) {
    case "claude":
      return "CLAUDE.md";
    case "cursor":
      return "CLAUDE.md";
    case "opencode":
      return "AGENTS.md";
    case "copilot":
      return ".github/copilot-instructions.md";
    case "windsurf":
      return ".windsurfrules";
    case "cline":
      return ".clinerules";
    case "continue":
      return ".continuerules";
    case "aider":
      return ".aider.conf.yml";
    case "generic":
      return "CONTEXT.md";
  }
}
