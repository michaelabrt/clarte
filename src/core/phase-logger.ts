/**
 * Phase logging functions for the analysis pipeline.
 * Each function logs the result of one analysis phase to the console.
 * These are separated from computation to keep the phase functions pure.
 */
import * as p from "@clack/prompts";
import { theme as t } from "../theme.js";
import { INSTABILITY_THRESHOLD } from "../config/thresholds.js";
import type {
  ArchitecturalLayer,
  Chokepoint,
  CircularDependency,
  Community,
  ContextAnalysis,
  CrossCuttingFile,
  FileInstability,
  GraphTopology,
  HubFile,
  InferredConventions,
  LayerConsistency,
  MonorepoAnalysis,
  ConfigConstraints,
  TestMapping,
} from "../types.js";
import type { LogCtx } from "../types/internal.js";

export function logHubFiles(hubFiles: HubFile[], log: LogCtx): void {
  if (log.jsonMode) return;
  const topHubName = hubFiles[0]?.path ?? "";
  p.log.step(
    hubFiles.length > 0
      ? `${t.brand("Key files")}      found ${t.textBold(String(hubFiles.length))} key files` +
          (topHubName ? t.muted(` (top: ${topHubName})`) : "")
      : `${t.brand("Key files")}      ${t.muted("no key files detected")}`,
  );
  if (log.verbose && hubFiles.length > 0) {
    for (const h of hubFiles.slice(0, 5)) {
      p.log.info(
        t.muted(`  ${h.path} (auth: ${h.authority.toFixed(3)}, hub: ${h.hubScore.toFixed(3)}, role: ${h.role})`),
      );
    }
  }
}

export function logCircularDeps(circularDeps: CircularDependency[], log: LogCtx): void {
  if (log.jsonMode) return;
  p.log.step(
    circularDeps.length === 0
      ? `${t.brand("Circular deps")}  no cycles found ${t.check()}`
      : `${t.brand("Circular deps")}  ${t.textBold(String(circularDeps.length))} cycle${circularDeps.length === 1 ? "" : "s"} found ${t.warn("\u26A0")}`,
  );
  if (log.verbose && circularDeps.length > 0) {
    for (const c of circularDeps.slice(0, 3)) {
      p.log.info(t.muted(`  ${c.chain.join(" \u2192 ")}`));
    }
  }
}

export function logLayers(layers: ArchitecturalLayer[], log: LogCtx): void {
  if (log.jsonMode) return;
  p.log.step(
    layers.length > 0
      ? `${t.brand("Layers")}         ${layers.map((l) => l.name).join(" \u2192 ")}`
      : `${t.brand("Layers")}         ${t.muted("no clear layers detected")}`,
  );
  if (log.verbose && layers.length > 0) {
    for (const l of layers) {
      p.log.info(t.muted(`  ${l.name}: ${l.files.length} files, depends on: ${l.dependsOn.join(", ") || "none"}`));
    }
  }
}

export function logInstabilities(instabilities: FileInstability[], log: LogCtx): void {
  if (log.jsonMode) return;
  const highInstability = instabilities.filter((f) => f.instability > INSTABILITY_THRESHOLD);
  p.log.step(
    highInstability.length > 0
      ? `${t.brand("Instability")}    ${t.textBold(String(highInstability.length))} high-risk file${highInstability.length === 1 ? "" : "s"} ${t.warn("\u26A0")}`
      : `${t.brand("Instability")}    ${t.muted("all files within healthy range")} ${t.check()}`,
  );
  if (log.verbose && highInstability.length > 0) {
    for (const f of highInstability.slice(0, 5)) {
      p.log.info(t.muted(`  ${f.path} (I=${f.instability.toFixed(2)}, fan-in=${f.fanIn}, fan-out=${f.fanOut})`));
    }
  }
}

export function logCommunities(communities: Community[], log: LogCtx): void {
  if (log.jsonMode) return;
  p.log.step(
    communities.length > 0
      ? `${t.brand("Clusters")}       ${t.textBold(String(communities.length))} module cluster${communities.length === 1 ? "" : "s"}`
      : `${t.brand("Clusters")}       ${t.muted("single cohesive module")}`,
  );
  if (log.verbose && communities.length > 0) {
    for (const c of communities.slice(0, 5)) {
      p.log.info(t.muted(`  ${c.label} (${c.files.length} files)`));
    }
  }
}

export function logDeadFiles(deadFiles: string[], log: LogCtx): void {
  if (log.jsonMode || deadFiles.length === 0) return;
  p.log.step(
    `${t.brand("Dead files")}     ${t.textBold(String(deadFiles.length))} file${deadFiles.length === 1 ? "" : "s"} not imported by anything ${t.warn("\u26A0")}`,
  );
  if (log.verbose) {
    for (const f of deadFiles.slice(0, 5)) {
      p.log.info(t.muted(`  ${f}`));
    }
  }
}

export function logCrossCuttingFiles(crossCuttingFiles: CrossCuttingFile[], log: LogCtx): void {
  if (log.jsonMode || crossCuttingFiles.length === 0) return;
  p.log.step(
    `${t.brand("Cross-cutting")}  ${t.textBold(String(crossCuttingFiles.length))} file${crossCuttingFiles.length === 1 ? "" : "s"} span ${t.textBold("3+")} layers`,
  );
  if (log.verbose) {
    for (const f of crossCuttingFiles.slice(0, 5)) {
      p.log.info(t.muted(`  ${f.file} (${f.layerSpread} layers: ${f.layers.join(", ")})`));
    }
  }
}

export function logLayerConsistency(layerConsistency: LayerConsistency | undefined, log: LogCtx): void {
  if (log.jsonMode || !layerConsistency) return;
  const pct = (layerConsistency.consistency * 100).toFixed(0);
  const violationCount = layerConsistency.violations.length;
  p.log.step(
    violationCount === 0
      ? `${t.brand("Layer order")}    ${pct}% consistent ${t.check()}`
      : `${t.brand("Layer order")}    ${pct}% consistent, ${t.textBold(String(violationCount))} violation${violationCount === 1 ? "" : "s"} ${t.warn("\u26A0")}`,
  );
  if (log.verbose && violationCount > 0) {
    for (const v of layerConsistency.violations.slice(0, 3)) {
      p.log.info(t.muted(`  ${v.from} (${v.fromLayer}) imports ${v.to} (${v.toLayer})`));
    }
  }
}

export function logChokepoints(chokepoints: Chokepoint[], log: LogCtx): void {
  if (log.jsonMode || chokepoints.length === 0) return;
  p.log.step(
    `${t.brand("Chokepoints")}    ${t.textBold(String(chokepoints.length))} structural chokepoint${chokepoints.length === 1 ? "" : "s"}`,
  );
  if (log.verbose) {
    for (const cp of chokepoints.slice(0, 5)) {
      p.log.info(t.muted(`  ${cp.file} (${cp.upstreamCount} dependents, ${cp.downstreamCount ?? 0} dependencies)`));
    }
  }
}

export function logTopology(graphTopology: GraphTopology, log: LogCtx): void {
  if (log.jsonMode) return;
  if (graphTopology.isFragmented) {
    p.log.step(
      `${t.brand("Topology")}       ${t.textBold(String(graphTopology.componentCount))} connected component${graphTopology.componentCount === 1 ? "" : "s"} (fragmented) ${t.warn("\u26A0")}`,
    );
    if (log.verbose) {
      const sizes = graphTopology.componentSizes.slice(0, 5).join(", ");
      p.log.info(t.muted(`  Component sizes: ${sizes}${graphTopology.componentSizes.length > 5 ? ", ..." : ""}`));
      p.log.info(t.muted(`  Approximate diameter: ${graphTopology.approximateDiameter} hops`));
    }
  } else if (log.verbose) {
    p.log.step(
      `${t.brand("Topology")}       single connected graph, diameter ~${graphTopology.approximateDiameter} hops`,
    );
  }
  if (log.verbose && graphTopology.criticalChainLength != null) {
    p.log.info(t.muted(`  Critical chain: ${graphTopology.criticalChainLength} layers deep`));
  }
  if (log.verbose && graphTopology.modularityQ != null) {
    const qStr = graphTopology.modularityQ.toFixed(2);
    p.log.info(t.muted(`  Modularity Q: ${qStr} (directory-based)`));
  }
}

export function logGitActivity(gitActivity: ContextAnalysis["gitActivity"], analysisDays: number, log: LogCtx): void {
  if (log.jsonMode) return;
  if (gitActivity) {
    const coupledPairs = gitActivity.changeCoupling.length;
    p.log.step(
      `${t.brand(`Git (${analysisDays}d)`)}      ${t.textBold(String(gitActivity.hotFiles.length))} active file${gitActivity.hotFiles.length === 1 ? "" : "s"}, ${t.textBold(String(coupledPairs))} coupled pair${coupledPairs === 1 ? "" : "s"}`,
    );
    if (log.verbose) {
      for (const h of gitActivity.hotFiles.slice(0, 5)) {
        p.log.info(t.muted(`  ${h.path} (${h.commits} commits, last: ${h.lastChanged})`));
      }
    }
  } else {
    p.log.step(`${t.brand("Git")}            ${t.muted("not a git repo, skipped")}`);
  }
}

export function logConfigConstraints(configConstraints: ConfigConstraints, log: LogCtx): void {
  if (log.jsonMode) return;
  const hasConstraints = configConstraints.typescript || configConstraints.linter || configConstraints.formatter;
  if (!hasConstraints) return;
  const parts: string[] = [];
  if (configConstraints.typescript) parts.push("tsconfig");
  if (configConstraints.linter) parts.push(configConstraints.linter.tool.toLowerCase());
  if (configConstraints.formatter && !configConstraints.linter)
    parts.push(configConstraints.formatter.tool.toLowerCase());
  p.log.step(`${t.brand("Config")}         extracted constraints from ${parts.join(", ")}`);
}

export function logConventions(conventions: InferredConventions | null | undefined, log: LogCtx): void {
  if (log.jsonMode || !conventions) return;
  const parts: string[] = [];
  if (Object.values(conventions.naming).some((v) => v !== "mixed")) parts.push("naming");
  if (conventions.exportStyle.preferNamed) parts.push("exports");
  if (conventions.importOrdering) parts.push("imports");
  if (parts.length > 0) {
    p.log.step(`${t.brand("Conventions")}    inferred ${parts.join(", ")} patterns`);
  }
}

export function logTestMapping(testMapping: TestMapping | null | undefined, log: LogCtx): void {
  if (log.jsonMode || !testMapping) return;
  const coveredCount = testMapping.sourceToTests.size;
  const untestedCount = testMapping.untestedFiles.length;
  p.log.step(
    `${t.brand("Test map")}       ${t.textBold(String(coveredCount))} source file${coveredCount === 1 ? "" : "s"} with tests` +
      (untestedCount > 0 ? `, ${t.warn(String(untestedCount))} untested` : ` ${t.check()}`),
  );
  if (log.verbose && untestedCount > 0) {
    for (const f of testMapping.untestedFiles.slice(0, 5)) {
      p.log.info(t.muted(`  untested: ${f}`));
    }
  }
}

export function logMonorepoAnalysis(monorepoAnalysis: MonorepoAnalysis | undefined, log: LogCtx): void {
  if (log.jsonMode || !monorepoAnalysis) return;
  const edgeCount = monorepoAnalysis.crossPackageEdges.length;
  const violationCount = monorepoAnalysis.encapsulationViolations.length;
  if (edgeCount === 0) return;
  p.log.step(
    `${t.brand("Packages")}       ${t.textBold(String(edgeCount))} cross-package edge${edgeCount === 1 ? "" : "s"}` +
      (violationCount > 0
        ? `, ${t.warn(String(violationCount))} encapsulation violation${violationCount === 1 ? "" : "s"}`
        : ` ${t.check()}`),
  );
  if (log.verbose && violationCount > 0) {
    for (const v of monorepoAnalysis.encapsulationViolations.slice(0, 5)) {
      p.log.info(t.muted(`  ${v.from} -> ${v.to} (${v.fromPackage} -> ${v.toPackage})`));
    }
  }
}

export function logDelta(deltaSection: string | null, log: LogCtx): void {
  if (log.jsonMode || !deltaSection) return;
  p.log.step(`${t.brand("Delta")}          architecture changes detected since last run`);
  if (log.verbose) {
    for (const line of deltaSection.split("\n").filter((l) => l.startsWith("- "))) {
      p.log.info(t.muted(`  ${line.slice(2)}`));
    }
  }
}
