import path from "node:path";
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import { theme as t, unpatchPicocolors } from "./theme.js";
import { writeFileSafe } from "./utils.js";
import { detectContext, enrichFrameworksWithUsage } from "./detect/detect.js";
import { buildGraphWithCache } from "./graph/cache.js";
import { buildImportGraph, mergeGraph } from "./graph/build.js";
import { findCircularDeps } from "./graph/cycles.js";
import { getHubFiles } from "./graph/hub-files.js";
import { detectArchitecturalLayers } from "./graph/layers.js";
import { computeInstability } from "./graph/instability.js";
import { detectCommunities } from "./graph/communities.js";
import { analyzeGitActivity } from "./git/analysis.js";
import { loadConfig } from "./config/config.js";
import { buildTestMapping } from "./analysis/test-map.js";
import { generateSnapshot } from "./snapshot.js";
import { buildDirectives } from "./templates/directives.js";
import { startShimmer } from "./animations.js";
import type { ContextAnalysis, ProgressCallback } from "./types.js";

export async function runDiffMode(
  rootDir: string,
  ref?: string,
  verbose = false,
  outputFile?: string,
  filterFiles: string[] = [],
): Promise<void> {
  const verboseLog: ProgressCallback = (msg) => {
    if (verbose) p.log.info(t.muted(msg));
  };

  // Validate ref to prevent shell injection (only allow git ref characters)
  if (ref && !/^[\w./:@^~{}-]+$/.test(ref)) {
    p.log.error(t.error(`Invalid git ref: ${ref}`));
    return;
  }

  let changedFiles: string[];
  let diffStat: Map<string, { added: number; removed: number }> | null = null;
  try {
    const cmd = ref ? `git diff --name-only ${ref}...HEAD` : "git diff --name-only HEAD";
    let output = execSync(cmd, {
      cwd: rootDir,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!ref) {
      const staged = execSync("git diff --name-only --cached", {
        cwd: rootDir,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const unstaged = execSync("git diff --name-only", { cwd: rootDir, encoding: "utf-8", timeout: 5000 }).trim();
      output = [output, staged, unstaged].filter(Boolean).join("\n");
    }

    changedFiles = [...new Set(output.split("\n").filter(Boolean))];

    if (filterFiles.length > 0) {
      const filterSet = new Set(filterFiles.map((f) => path.normalize(f)));
      changedFiles = changedFiles.filter((f) => filterSet.has(path.normalize(f)));
    }

    try {
      const statCmd = ref ? `git diff --numstat ${ref}...HEAD` : "git diff --numstat HEAD";
      let statOutput = execSync(statCmd, { cwd: rootDir, encoding: "utf-8", timeout: 10000 }).trim();
      if (!ref) {
        const stagedStat = execSync("git diff --numstat --cached", {
          cwd: rootDir,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        const unstagedStat = execSync("git diff --numstat", { cwd: rootDir, encoding: "utf-8", timeout: 5000 }).trim();
        statOutput = [statOutput, stagedStat, unstagedStat].filter(Boolean).join("\n");
      }
      diffStat = new Map();
      for (const line of statOutput.split("\n").filter(Boolean)) {
        const [addStr, rmStr, file] = line.split("\t");
        if (file && addStr !== "-") {
          const existing = diffStat.get(file);
          const added = parseInt(addStr, 10) || 0;
          const removed = parseInt(rmStr, 10) || 0;
          if (existing) {
            existing.added += added;
            existing.removed += removed;
          } else {
            diffStat.set(file, { added, removed });
          }
        }
      }
    } catch {
      // Line counts are optional; continue without them
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ref && (msg.includes("unknown revision") || msg.includes("bad revision"))) {
      p.log.error(t.text(`Failed to resolve ref '${ref}'. Verify the branch or commit exists.`));
    } else {
      p.log.error(t.text("Failed to get changed files from git. Is this a git repo?"));
    }
    process.exit(1);
  }

  if (changedFiles.length === 0) {
    if (filterFiles.length > 0) {
      p.log.info(t.text(`No changes found for: ${filterFiles.join(", ")}`));
    } else {
      p.log.info(t.text("No changed files detected."));
    }
    return;
  }

  p.log.step(t.text(`${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}`));

  const shimmer = startShimmer("Building import graph...");
  const detected = await detectContext(rootDir, verboseLog);
  const graph = await buildGraphWithCache(rootDir, detected.language, verboseLog);

  if (detected.secondaryLanguages) {
    for (const secLang of detected.secondaryLanguages) {
      const secGraph = await buildImportGraph(rootDir, secLang, verboseLog);
      mergeGraph(graph, secGraph);
    }
  }

  detected.frameworks = enrichFrameworksWithUsage(detected.frameworks, graph.externalImportCounts);

  shimmer.stop();

  const changedSet = new Set(changedFiles);
  const { hop1: hop1Set, hop2: hop2Set } = computeNeighborhood(changedSet, graph.edges);

  const neighborSet = new Set([...hop1Set, ...hop2Set]);

  const testMapping = buildTestMapping(graph, detected);
  const testFiles = new Set<string>();
  for (const f of changedSet) {
    const tests = testMapping?.sourceToTests.get(f);
    if (tests) {
      for (const tf of tests) testFiles.add(tf);
    }
  }
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (changedSet.has(edge.to) && isDiffTestFile(edge.from)) {
      testFiles.add(edge.from);
    }
  }

  const diffConfig = await loadConfig(rootDir);
  const customLayers = diffConfig?.layers;
  const allHubFiles = getHubFiles(graph);
  const hubFileMap = new Map(allHubFiles.map((h) => [h.path, h]));
  const allCircularDeps = findCircularDeps(graph);
  const { layers, layerEdges } = detectArchitecturalLayers(graph, customLayers);
  const instabilities = computeInstability(graph);
  const communities = detectCommunities(graph);
  const gitActivity = detected.isGitRepo ? analyzeGitActivity(rootDir, verboseLog) : null;

  const relevantHub = scopeHubFiles(allHubFiles, changedSet, hop1Set, hop2Set);
  const relevantCycles = scopeCircularDeps(allCircularDeps, changedSet, hop1Set);

  const analysis: ContextAnalysis = {
    hubFiles: relevantHub,
    circularDeps: relevantCycles,
    layers,
    layerEdges,
    gitActivity,
    instabilities,
    communities,
  };

  const snapshot = await generateSnapshot(detected, [], graph);
  const entryIndex = new Map<string, typeof snapshot.entries>();
  if (snapshot) {
    for (const entry of snapshot.entries) {
      const arr = entryIndex.get(entry.file) ?? [];
      arr.push(entry);
      entryIndex.set(entry.file, arr);
    }
  }

  const allRelevant = [...changedSet, ...neighborSet, ...testFiles];

  p.log.step(
    t.text(
      `Scope: ${changedFiles.length} changed, ${hop1Set.size} direct + ${hop2Set.size} indirect neighbor${hop1Set.size + hop2Set.size === 1 ? "" : "s"}, ${testFiles.size} test file${testFiles.size === 1 ? "" : "s"}`,
    ),
  );

  const sections: string[] = [];
  const isSingleFile = changedFiles.length === 1;

  if (isSingleFile) {
    const f = changedFiles[0];
    const hub = hubFileMap.get(f);
    const importedBy = graph.inDegree.get(f) ?? 0;
    const role = hub?.role ?? "Leaf";
    const stat = diffStat?.get(f);
    const statStr = stat ? `, +${stat.added} / -${stat.removed}` : "";
    sections.push("# Diff Context");
    sections.push("");
    sections.push(
      `> \`${f}\` (${role}, imported by ${importedBy}${statStr})${ref ? ` vs \`${ref}\`` : ""}. Generated by Clart\u00e9.`,
    );
    sections.push("");

    // Inline risk annotation for the single file
    if (hub && (hub.role === "Foundation" || hub.role === "Orchestrator" || hub.role === "Bridge")) {
      sections.push(
        `**Risk:** ${hub.role} file, imported by ${hub.importedBy} file${hub.importedBy === 1 ? "" : "s"}. Check dependents for breaking changes.`,
      );
      sections.push("");
    }
  } else {
    sections.push("# Diff Context");
    sections.push("");
    sections.push(
      `> Focused context for ${changedFiles.length} changed files${ref ? ` vs \`${ref}\`` : ""}. Generated by Clart\u00e9.`,
    );
    sections.push("");

    sections.push("## Changed Files");
    sections.push("");
    if (diffStat && diffStat.size > 0) {
      sections.push("| File | Role | Imported By | Lines (+/-) |");
      sections.push("|------|------|-------------|-------------|");
      for (const f of changedFiles) {
        const hub = hubFileMap.get(f);
        const importedBy = graph.inDegree.get(f) ?? 0;
        const role = hub?.role ?? "Leaf";
        const stat = diffStat.get(f);
        const statStr = stat ? `+${stat.added} / -${stat.removed}` : "";
        sections.push(`| \`${f}\` | ${role} | ${importedBy} | ${statStr} |`);
      }
    } else {
      sections.push("| File | Role | Imported By |");
      sections.push("|------|------|-------------|");
      for (const f of changedFiles) {
        const hub = hubFileMap.get(f);
        const importedBy = graph.inDegree.get(f) ?? 0;
        const role = hub?.role ?? "Leaf";
        sections.push(`| \`${f}\` | ${role} | ${importedBy} |`);
      }
    }
    sections.push("");

    const riskNotes: string[] = [];
    for (const f of changedFiles) {
      const hub = hubFileMap.get(f);
      if (hub && (hub.role === "Foundation" || hub.role === "Orchestrator" || hub.role === "Bridge")) {
        riskNotes.push(
          `\`${f}\` is a ${hub.role} file, imported by ${hub.importedBy} file${hub.importedBy === 1 ? "" : "s"}. Check dependents for breaking changes.`,
        );
      }
    }
    if (riskNotes.length > 0) {
      sections.push("### Risk Annotations");
      sections.push("");
      for (const note of riskNotes) {
        sections.push(`- ${note}`);
      }
      sections.push("");
    }
  }

  if (gitActivity?.changeCoupling) {
    const suggestions: string[] = [];
    for (const f of changedFiles) {
      const partners = gitActivity.changeCoupling
        .filter(
          (c) =>
            c.confidence >= 0.5 &&
            ((c.fileA === f && !changedSet.has(c.fileB)) || (c.fileB === f && !changedSet.has(c.fileA))),
        )
        .map((c) => {
          const partner = c.fileA === f ? c.fileB : c.fileA;
          const pct = Math.round(c.confidence * 100);
          return `\`${partner}\` (${pct}% co-change)`;
        });
      if (partners.length > 0) {
        suggestions.push(`When modifying \`${f}\`, consider also checking: ${partners.join(", ")}`);
      }
    }
    if (suggestions.length > 0) {
      sections.push("### Temporal Coupling");
      sections.push("");
      sections.push("> Files that frequently change together but are not in this diff.");
      sections.push("");
      for (const s of suggestions) {
        sections.push(`- ${s}`);
      }
      sections.push("");
    }
  }

  const cycleNotes: string[] = [];
  for (const dep of relevantCycles) {
    const chainStr = dep.chain.map((f) => `\`${f}\``).join(" -> ");
    if (dep.breakHint) {
      cycleNotes.push(`Cycle: ${chainStr}. ${dep.breakHint}`);
    } else {
      cycleNotes.push(`Cycle: ${chainStr}. Consider breaking this circular dependency.`);
    }
  }
  if (cycleNotes.length > 0) {
    sections.push("### Circular Dependencies");
    sections.push("");
    sections.push("> Changed files participate in these cycles.");
    sections.push("");
    for (const note of cycleNotes) {
      sections.push(`- ${note}`);
    }
    sections.push("");
  }

  if (hop1Set.size > 0 || hop2Set.size > 0) {
    sections.push("## Neighbors");
    sections.push("");

    if (hop1Set.size > 0) {
      sections.push("### Direct (1-hop)");
      sections.push("");
      sections.push("| File | Role | Imported By |");
      sections.push("|------|------|-------------|");
      for (const f of [...hop1Set].sort()) {
        const hub = hubFileMap.get(f);
        const importedBy = graph.inDegree.get(f) ?? 0;
        const role = hub?.role ?? "Leaf";
        sections.push(`| \`${f}\` | ${role} | ${importedBy} |`);
      }
      sections.push("");
    }

    if (hop2Set.size > 0) {
      const hop2Capped = [...hop2Set].sort().slice(0, 15);
      sections.push("### Indirect (2-hop)");
      sections.push("");
      sections.push("| File | Role | Imported By |");
      sections.push("|------|------|-------------|");
      for (const f of hop2Capped) {
        const hub = hubFileMap.get(f);
        const importedBy = graph.inDegree.get(f) ?? 0;
        const role = hub?.role ?? "Leaf";
        sections.push(`| \`${f}\` | ${role} | ${importedBy} |`);
      }
      sections.push("");
    }
  }

  if (testFiles.size > 0) {
    sections.push("## Related Tests");
    sections.push("");
    sections.push("> Run these tests after your changes.");
    sections.push("");
    for (const f of [...testFiles].sort()) {
      sections.push(`- \`${f}\``);
    }
    sections.push("");
  }

  const filesWithEntries = [...changedSet, ...neighborSet]
    .filter((f) => entryIndex.has(f))
    .sort((a, b) => (graph.centrality.get(b) ?? 0) - (graph.centrality.get(a) ?? 0));

  if (filesWithEntries.length > 0) {
    sections.push("## Signatures in Scope");
    sections.push("");
    sections.push("Key type signatures and function declarations from changed and neighbor files.");
    sections.push("");
    sections.push("```ts");
    for (const f of filesWithEntries.slice(0, 20)) {
      const entries = entryIndex.get(f) ?? [];
      if (entries.length === 0) continue;
      sections.push(`// ${f}`);
      for (const e of entries.slice(0, 5)) {
        sections.push(e.signature);
        sections.push("");
      }
    }
    sections.push("```");
    sections.push("");
  }

  const allDirectives = buildDirectives(analysis, detected);
  const scopedDirectives = allDirectives.filter((d) => changedFiles.some((f) => d.includes(f)));
  if (scopedDirectives.length > 0) {
    sections.push("## Working Guidelines");
    sections.push("");
    sections.push("> Scoped directives for changed files.");
    sections.push("");
    for (const d of scopedDirectives) {
      sections.push(`- ${d}`);
    }
    sections.push("");
  }

  // Hint when single-file filter produces sparse output (file not in import graph)
  if (isSingleFile && hop1Set.size === 0 && testFiles.size === 0 && filesWithEntries.length === 0) {
    sections.push("> This file is not in the import graph. Run `--diff` without file arguments to see all changes.");
    sections.push("");
  }

  const content = sections.join("\n");

  if (outputFile) {
    const outPath = path.resolve(rootDir, outputFile);
    await writeFileSafe(outPath, content);
    p.log.step(t.text(`Written to ${t.accent(outputFile)}`));
  } else {
    process.stdout.write(content);
  }

  p.outro(t.success("Diff context ready. ") + t.muted(`${allRelevant.length} files in scope.`));
  unpatchPicocolors();
}

function isDiffTestFile(filePath: string): boolean {
  return (
    /\.(test|spec)\.[jt]sx?$/.test(filePath) ||
    /\/__tests__\//.test(filePath) ||
    /\/test_[^/]+\.py$/.test(filePath) ||
    /\/tests\//.test(filePath)
  );
}

/**
 * Compute 2-hop neighborhoods from a set of changed files in an import graph.
 * Returns separate sets for 1-hop (direct) and 2-hop (indirect) neighbors.
 */
export function computeNeighborhood(
  changedFiles: Set<string>,
  edges: Array<{ from: string; to: string; isExternal: boolean }>,
): { hop1: Set<string>; hop2: Set<string> } {
  const hop1 = new Set<string>();

  for (const edge of edges) {
    if (edge.isExternal) continue;
    if (changedFiles.has(edge.from)) hop1.add(edge.to);
    if (changedFiles.has(edge.to)) hop1.add(edge.from);
  }
  for (const f of changedFiles) hop1.delete(f);

  const hop2 = new Set<string>();
  for (const edge of edges) {
    if (edge.isExternal) continue;
    if (hop1.has(edge.from) && !changedFiles.has(edge.to) && !hop1.has(edge.to)) {
      hop2.add(edge.to);
    }
    if (hop1.has(edge.to) && !changedFiles.has(edge.from) && !hop1.has(edge.from)) {
      hop2.add(edge.from);
    }
  }

  return { hop1, hop2 };
}

/**
 * Filter hub files to only those in the given neighborhood (changed + hop1 + hop2).
 */
export function scopeHubFiles<T extends { path: string }>(
  hubFiles: T[],
  changedSet: Set<string>,
  hop1Set: Set<string>,
  hop2Set: Set<string>,
): T[] {
  return hubFiles.filter((h) => changedSet.has(h.path) || hop1Set.has(h.path) || hop2Set.has(h.path));
}

/**
 * Filter circular dependencies to only those where at least one file
 * is in the changed or hop1 neighborhood.
 */
export function scopeCircularDeps<T extends { chain: string[] }>(
  circularDeps: T[],
  changedSet: Set<string>,
  hop1Set: Set<string>,
): T[] {
  return circularDeps.filter((dep) => dep.chain.some((f) => changedSet.has(f) || hop1Set.has(f)));
}
