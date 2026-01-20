import type {
  ArchitecturalLayer,
  ContextAnalysis,
  ContextSection,
  DetectedContext,
  ImportGraph,
  LayerEdge,
} from "../../types.js";
import { estimateTokens } from "../../utils.js";
import { computeAllInstabilities } from "../../graph/instability.js";
import { renderDirectivesSection } from "../directives.js";
import { renderConstraintsSection } from "../../config/scan.js";

export async function renderArchitectureSections(
  analysis: ContextAnalysis,
  ctx: DetectedContext,
  graph?: ImportGraph,
): Promise<ContextSection[]> {
  const sections: ContextSection[] = [];

  if (analysis.configConstraints) {
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

  const directivesSection = await renderDirectivesSection(analysis, ctx, graph);
  if (directivesSection) {
    sections.push({
      id: "working-guidelines",
      priority: 2,
      content: directivesSection,
      tokens: estimateTokens(directivesSection),
    });
  }

  if (analysis.hubFiles && analysis.hubFiles.length > 0) {
    const instabilityMap = new Map<string, number>();
    if (analysis.instabilities) {
      for (const inst of analysis.instabilities) {
        instabilityMap.set(inst.path, inst.instability);
      }
    }

    // Detect SDP violations: a stable file (low I) importing an unstable file (high I).
    // Requires the full graph; without it we emit no warnings to avoid false positives.
    // Orchestrators are exempt: they are expected to have high instability by design.
    const orchestratorPaths = new Set(analysis.hubFiles.filter((h) => h.role === "Orchestrator").map((h) => h.path));
    const sdpViolations = new Set<string>();
    if (graph) {
      const allInstabilities = computeAllInstabilities(graph);
      for (const edge of graph.edges) {
        if (edge.isExternal) continue;
        if (orchestratorPaths.has(edge.to)) continue;
        const importerI = allInstabilities.get(edge.from) ?? 0;
        const importedI = allInstabilities.get(edge.to) ?? 0;
        if (importerI < importedI) {
          sdpViolations.add(edge.to);
        }
      }
    }

    const keyLines: string[] = [];
    keyLines.push("## Key Files");
    keyLines.push("");
    keyLines.push("These are the most interconnected files. Read these first for architectural understanding.");
    keyLines.push("");
    keyLines.push("| File | Imported By | I |");
    keyLines.push("|------|-------------|---|");
    for (const hub of analysis.hubFiles) {
      const inst = instabilityMap.get(hub.path);
      const stabilityCell =
        inst == null
          ? "stable"
          : sdpViolations.has(hub.path)
            ? `I=${(inst * 100).toFixed(0)}% - SDP \u26A0\uFE0F`
            : `I=${(inst * 100).toFixed(0)}%`;
      const roleTag = hub.role !== "Leaf" ? ` (${hub.role})` : "";
      keyLines.push(
        `| \`${hub.path}\`${roleTag} | ${hub.importedBy} file${hub.importedBy === 1 ? "" : "s"} | ${stabilityCell} |`,
      );
    }
    const keyContent = keyLines.join("\n");
    sections.push({ id: "key-files", priority: 2, content: keyContent, tokens: estimateTokens(keyContent) });
  }

  if (analysis.layers && analysis.layers.length > 1) {
    const archLines: string[] = [];
    archLines.push("## Architecture");
    archLines.push("");
    archLines.push(renderArchitectureDiagram(analysis.layers, analysis.layerEdges ?? []));
    const archContent = archLines.join("\n");
    sections.push({ id: "architecture", priority: 4, content: archContent, tokens: estimateTokens(archContent) });
  }

  if (analysis.monorepoAnalysis && analysis.monorepoAnalysis.crossPackageEdges.length > 0) {
    const mono = analysis.monorepoAnalysis;
    const pkgLines: string[] = [];
    pkgLines.push("## Package Dependencies");
    pkgLines.push("");

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

  const lcSection = renderLayerConsistencySection(analysis);
  if (lcSection) sections.push(lcSection);

  return sections;
}

/**
 * Render the layer-consistency section as a standalone export.
 * Used by both renderArchitectureSections and the code-health skill.
 */
export function renderLayerConsistencySection(analysis: ContextAnalysis): ContextSection | null {
  if (!analysis.layerConsistency || !analysis.layers || analysis.layers.length <= 1) return null;
  const lc = analysis.layerConsistency;
  if (lc.violations.length === 0) return null;

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
  return { id: "layer-consistency", priority: 10, content: lcContent, tokens: estimateTokens(lcContent) };
}

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
