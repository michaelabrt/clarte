import fs from "node:fs/promises";
import path from "node:path";
import type { ContextAnalysis } from "../types.js";
import { CLARTE_DIR } from "../config/config.js";
const HISTORY_FILE = "history.json";

export interface AnalysisSnapshot {
  timestamp: string;
  hubFilePaths: string[];
  hubFileRoles: Record<string, string>;
  circularDepChains: string[][];
  deadFiles: string[];
  chokepointPaths: string[];
  layerViolationCount: number;
  criticalChainLength?: number;
  modularityQ?: number;
}

export interface ArchitectureDelta {
  newHubFiles: string[];
  demotedHubFiles: string[];
  newCircularDeps: string[][];
  resolvedCircularDeps: string[][];
  newDeadFiles: string[];
  resurrectedFiles: string[];
  newChokepoints: string[];
  resolvedChokepoints: string[];
  layerViolationDelta: number;
  criticalChainDelta?: number;
  modularityQDelta?: number;
}

export async function loadPreviousSnapshot(rootDir: string): Promise<AnalysisSnapshot | null> {
  const filePath = path.join(rootDir, CLARTE_DIR, HISTORY_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as AnalysisSnapshot;
  } catch {
    return null;
  }
}

export async function saveSnapshot(rootDir: string, snapshot: AnalysisSnapshot): Promise<void> {
  const dir = path.join(rootDir, CLARTE_DIR);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, HISTORY_FILE);
  await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), "utf-8");
}

export function extractSnapshot(analysis: ContextAnalysis): AnalysisSnapshot {
  const hubFilePaths = analysis.hubFiles.map((h) => h.path);
  const hubFileRoles: Record<string, string> = {};
  for (const h of analysis.hubFiles) {
    hubFileRoles[h.path] = h.role;
  }

  const circularDepChains = analysis.circularDeps.map((c) => [...c.chain]);
  const deadFiles = analysis.deadFiles ? [...analysis.deadFiles] : [];
  const chokepointPaths = analysis.chokepoints ? analysis.chokepoints.map((cp) => cp.file) : [];
  const layerViolationCount = analysis.layerConsistency?.violations.length ?? 0;

  return {
    timestamp: new Date().toISOString(),
    hubFilePaths,
    hubFileRoles,
    circularDepChains,
    deadFiles,
    chokepointPaths,
    layerViolationCount,
    criticalChainLength: analysis.graphTopology?.criticalChainLength,
    modularityQ: analysis.graphTopology?.modularityQ,
  };
}

/** Serialize a cycle chain for comparison (sorted canonical form). */
function canonicalCycle(chain: string[]): string {
  return [...chain].sort().join("\0");
}

export function computeDelta(previous: AnalysisSnapshot, current: AnalysisSnapshot): ArchitectureDelta {
  const prevHubs = new Set(previous.hubFilePaths);
  const currHubs = new Set(current.hubFilePaths);

  const newHubFiles = current.hubFilePaths.filter((f) => !prevHubs.has(f));
  const demotedHubFiles = previous.hubFilePaths.filter((f) => !currHubs.has(f));

  const prevCycles = new Set(previous.circularDepChains.map(canonicalCycle));
  const currCycles = new Set(current.circularDepChains.map(canonicalCycle));

  const newCircularDeps = current.circularDepChains.filter((c) => !prevCycles.has(canonicalCycle(c)));
  const resolvedCircularDeps = previous.circularDepChains.filter((c) => !currCycles.has(canonicalCycle(c)));

  const prevDead = new Set(previous.deadFiles);
  const currDead = new Set(current.deadFiles);

  const newDeadFiles = current.deadFiles.filter((f) => !prevDead.has(f));
  const resurrectedFiles = previous.deadFiles.filter((f) => !currDead.has(f));

  const prevChoke = new Set(previous.chokepointPaths);
  const currChoke = new Set(current.chokepointPaths);

  const newChokepoints = current.chokepointPaths.filter((f) => !prevChoke.has(f));
  const resolvedChokepoints = previous.chokepointPaths.filter((f) => !currChoke.has(f));

  const layerViolationDelta = current.layerViolationCount - previous.layerViolationCount;

  const criticalChainDelta =
    current.criticalChainLength != null && previous.criticalChainLength != null
      ? current.criticalChainLength - previous.criticalChainLength
      : undefined;

  const modularityQDelta =
    current.modularityQ != null && previous.modularityQ != null ? current.modularityQ - previous.modularityQ : undefined;

  return {
    newHubFiles,
    demotedHubFiles,
    newCircularDeps,
    resolvedCircularDeps,
    newDeadFiles,
    resurrectedFiles,
    newChokepoints,
    resolvedChokepoints,
    layerViolationDelta,
    criticalChainDelta,
    modularityQDelta,
  };
}

/** Check whether a delta contains any changes. */
export function isDeltaEmpty(delta: ArchitectureDelta): boolean {
  return (
    delta.newHubFiles.length === 0 &&
    delta.demotedHubFiles.length === 0 &&
    delta.newCircularDeps.length === 0 &&
    delta.resolvedCircularDeps.length === 0 &&
    delta.newDeadFiles.length === 0 &&
    delta.resurrectedFiles.length === 0 &&
    delta.newChokepoints.length === 0 &&
    delta.resolvedChokepoints.length === 0 &&
    delta.layerViolationDelta === 0 &&
    (delta.criticalChainDelta ?? 0) === 0 &&
    Math.abs(delta.modularityQDelta ?? 0) < 0.01
  );
}

/**
 * Render a "## Architecture Changes" markdown section from a delta.
 * Returns null if the delta has no changes.
 */
export function renderDeltaSection(delta: ArchitectureDelta): string | null {
  if (isDeltaEmpty(delta)) return null;

  const lines: string[] = [];
  lines.push("## Architecture Changes (since last analysis)");
  lines.push("");

  for (const f of delta.newHubFiles) {
    lines.push(`- \`${f}\` is a new hub file. Treat as a key dependency; check dependents when modifying.`);
  }

  for (const f of delta.demotedHubFiles) {
    lines.push(`- \`${f}\` is no longer a top hub file (fewer dependents now).`);
  }

  for (const chain of delta.newCircularDeps) {
    const chainStr = chain.map((f) => `\`${f}\``).join(" -> ");
    lines.push(`- New circular dependency: ${chainStr}.`);
  }

  for (const chain of delta.resolvedCircularDeps) {
    const chainStr = chain.map((f) => `\`${f}\``).join(" -> ");
    lines.push(`- Circular dependency resolved: ${chainStr}.`);
  }

  if (delta.newDeadFiles.length > 0) {
    if (delta.newDeadFiles.length <= 3) {
      for (const f of delta.newDeadFiles) {
        lines.push(`- \`${f}\` is now a dead file (no importers).`);
      }
    } else {
      lines.push(
        `- ${delta.newDeadFiles.length} new dead files detected: ${delta.newDeadFiles
          .slice(0, 3)
          .map((f) => `\`${f}\``)
          .join(", ")}, ...`,
      );
    }
  }

  if (delta.resurrectedFiles.length > 0) {
    if (delta.resurrectedFiles.length <= 3) {
      for (const f of delta.resurrectedFiles) {
        lines.push(`- \`${f}\` is no longer dead (gained importers).`);
      }
    } else {
      lines.push(`- ${delta.resurrectedFiles.length} previously dead files now have importers.`);
    }
  }

  for (const f of delta.newChokepoints) {
    lines.push(`- \`${f}\` is a new structural chokepoint. Refactor with care.`);
  }

  for (const f of delta.resolvedChokepoints) {
    lines.push(`- \`${f}\` is no longer a chokepoint (alternative paths exist now).`);
  }

  if (delta.layerViolationDelta > 0) {
    lines.push(
      `- ${delta.layerViolationDelta} new layer violation${delta.layerViolationDelta === 1 ? "" : "s"} detected. Do not add more upward dependencies.`,
    );
  } else if (delta.layerViolationDelta < 0) {
    lines.push(
      `- ${Math.abs(delta.layerViolationDelta)} layer violation${Math.abs(delta.layerViolationDelta) === 1 ? "" : "s"} fixed since last analysis.`,
    );
  }

  if (delta.criticalChainDelta != null && delta.criticalChainDelta !== 0) {
    if (delta.criticalChainDelta > 0) {
      lines.push(`- Critical chain grew by ${delta.criticalChainDelta} (deeper dependency layering). Consider breaking long import chains.`);
    } else {
      lines.push(`- Critical chain shortened by ${Math.abs(delta.criticalChainDelta)} (flatter dependency structure).`);
    }
  }

  if (delta.modularityQDelta != null && Math.abs(delta.modularityQDelta) >= 0.01) {
    if (delta.modularityQDelta < 0) {
      lines.push(`- Modularity Q dropped by ${Math.abs(delta.modularityQDelta).toFixed(2)}. Cross-directory dependencies increased.`);
    } else {
      lines.push(`- Modularity Q improved by ${delta.modularityQDelta.toFixed(2)}. Directory boundaries are better respected.`);
    }
  }

  return lines.join("\n");
}

/**
 * Build delta directives for inclusion in the Working Guidelines section.
 * Returns an empty array if no delta or no changes.
 */
export function buildDeltaDirectives(delta: ArchitectureDelta): string[] {
  if (isDeltaEmpty(delta)) return [];

  const directives: string[] = [];

  for (const f of delta.newHubFiles) {
    directives.push(`\`${f}\` recently became a hub file. Check dependents before modifying.`);
  }

  for (const chain of delta.newCircularDeps) {
    const chainStr = chain.map((f) => `\`${f}\``).join(" -> ");
    directives.push(`New circular dependency detected: ${chainStr}. Avoid deepening this cycle.`);
  }

  if (delta.newDeadFiles.length > 0) {
    directives.push(
      `${delta.newDeadFiles.length} new dead file${delta.newDeadFiles.length === 1 ? "" : "s"} detected. Consider removing if unused.`,
    );
  }

  for (const f of delta.newChokepoints) {
    directives.push(`\`${f}\` is a new structural chokepoint. Add alternative import paths to reduce risk.`);
  }

  if (delta.layerViolationDelta > 0) {
    directives.push(
      `${delta.layerViolationDelta} new layer violation${delta.layerViolationDelta === 1 ? "" : "s"} detected. Do not add more upward dependencies.`,
    );
  }

  if (delta.criticalChainDelta != null && delta.criticalChainDelta > 0) {
    directives.push(`Critical chain grew by ${delta.criticalChainDelta}. Avoid adding more layers to long import chains.`);
  }

  if (delta.modularityQDelta != null && delta.modularityQDelta < -0.01) {
    directives.push(`Modularity Q dropped by ${Math.abs(delta.modularityQDelta).toFixed(2)}. Avoid adding more cross-directory dependencies.`);
  }

  return directives;
}
