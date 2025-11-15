/**
 * Cartographic Typification (R.2)
 *
 * Groups similar files into "pattern + instances" instead of listing
 * each individually. Reduces token usage on repetitive codebases
 * without losing information.
 *
 * Inspired by cartographic generalization: when making a map at smaller
 * scale, cartographers replace N similar features with a single pattern
 * description plus a list of instances.
 */

import type { HubFile, FileRole, ImportEdge } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

/** A group of structurally similar files. */
export interface FileGroup {
  /** Short label for the group (e.g., "API route handlers in `routes/`"). */
  label: string;
  /** Directory these files share. */
  directory: string;
  /** Common role across group members. */
  role: FileRole;
  /** Files in the group. */
  members: HubFile[];
  /** Members that deviate from the group pattern (rendered individually). */
  exceptions: HubFile[];
  /** Shared traits describing the pattern. */
  traits: GroupTraits;
}

/** Shared structural traits of a file group. */
export interface GroupTraits {
  /** Average authority score. */
  avgAuthority: number;
  /** Average importedBy count. */
  avgImportedBy: number;
  /** Common import targets (files imported by most members). */
  commonImports: string[];
  /** Common importers (files that import most members). */
  commonImporters: string[];
}

/** Result of typification: groups + ungrouped singletons. */
export interface TypificationResult {
  /** Groups of 3+ similar files. */
  groups: FileGroup[];
  /** Files that didn't fit any group (rendered individually). */
  ungrouped: HubFile[];
}

// ── Grouping logic ───────────────────────────────────────────────────

/**
 * Group hub files by structural similarity.
 *
 * Files are grouped when they share the same directory and role.
 * Groups must have at least `minGroupSize` members (default 3)
 * to justify the overhead of a pattern description.
 *
 * Within a group, members whose authority or importedBy deviates
 * significantly from the group mean are marked as exceptions and
 * rendered individually (cartographic "exaggeration").
 */
export function typifyFiles(
  hubFiles: HubFile[],
  edges: ImportEdge[],
  options?: { minGroupSize?: number; exceptionThreshold?: number },
): TypificationResult {
  const minGroupSize = options?.minGroupSize ?? 3;
  const exceptionThreshold = options?.exceptionThreshold ?? 2.0;

  // Build import/importer maps for trait extraction
  const importMap = buildImportMap(edges);
  const importerMap = buildImporterMap(edges);

  // Group candidates: (directory, role) -> files
  const buckets = new Map<string, HubFile[]>();
  for (const hub of hubFiles) {
    const dir = hub.path.includes("/") ? hub.path.split("/").slice(0, -1).join("/") : ".";
    const key = `${dir}|${hub.role}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(hub);
    buckets.set(key, bucket);
  }

  const groups: FileGroup[] = [];
  const ungrouped: HubFile[] = [];

  for (const [key, members] of buckets) {
    if (members.length < minGroupSize) {
      ungrouped.push(...members);
      continue;
    }

    const [directory, role] = key.split("|") as [string, FileRole];

    // Compute group traits
    const traits = computeTraits(members, importMap, importerMap);

    // Identify exceptions: members that deviate significantly
    const exceptions: HubFile[] = [];
    const normals: HubFile[] = [];

    for (const m of members) {
      const authorityDeviation = traits.avgAuthority > 0
        ? Math.abs(m.authority - traits.avgAuthority) / traits.avgAuthority
        : 0;
      const importedByDeviation = traits.avgImportedBy > 0
        ? Math.abs(m.importedBy - traits.avgImportedBy) / traits.avgImportedBy
        : 0;

      if (authorityDeviation > exceptionThreshold || importedByDeviation > exceptionThreshold) {
        exceptions.push(m);
      } else {
        normals.push(m);
      }
    }

    // If too many exceptions, the group isn't cohesive enough
    if (normals.length < minGroupSize) {
      ungrouped.push(...members);
      continue;
    }

    const label = buildGroupLabel(directory, role, normals.length);

    groups.push({
      label,
      directory,
      role,
      members: normals,
      exceptions,
      traits,
    });
  }

  // Sort: groups by directory, ungrouped by authority (descending)
  groups.sort((a, b) => a.directory.localeCompare(b.directory));
  ungrouped.sort((a, b) => b.authority - a.authority);

  return { groups, ungrouped };
}

// ── Rendering ────────────────────────────────────────────────────────

/**
 * Render typified hub files as a compact markdown section.
 *
 * Groups are rendered as a description + file list.
 * Ungrouped files and exceptions are rendered as individual table rows.
 * Returns null if there's nothing to render.
 */
export function renderTypifiedKeyFiles(
  result: TypificationResult,
  instabilityMap: Map<string, number>,
): string | null {
  if (result.groups.length === 0 && result.ungrouped.length === 0) {
    return null;
  }

  const lines: string[] = [];
  lines.push("## Key Files");
  lines.push("");
  lines.push("These are the most interconnected files. Read these first for architectural understanding.");

  // Render ungrouped files as individual table rows (traditional format)
  const individualFiles = [
    ...result.ungrouped,
    ...result.groups.flatMap((g) => g.exceptions),
  ].sort((a, b) => b.authority - a.authority);

  if (individualFiles.length > 0) {
    lines.push("");
    lines.push("| File | Imported By | Stability |");
    lines.push("|------|-------------|-----------|");
    for (const hub of individualFiles) {
      const inst = instabilityMap.get(hub.path);
      const stabilityCell = inst != null
        ? `${(inst * 100).toFixed(0)}% unstable \u26A0\uFE0F`
        : "stable";
      const roleTag = hub.role !== "Leaf" ? ` (${hub.role})` : "";
      lines.push(
        `| \`${hub.path}\`${roleTag} | ${hub.importedBy} file${hub.importedBy === 1 ? "" : "s"} | ${stabilityCell} |`,
      );
    }
  }

  // Render groups as compact pattern descriptions
  if (result.groups.length > 0) {
    for (const group of result.groups) {
      lines.push("");
      lines.push(`**${group.label}**: ${group.members.map((m) => `\`${m.path.split("/").pop()}\``).join(", ")}`);

      // Add shared traits as a compact summary
      const traitParts: string[] = [];
      if (group.traits.avgImportedBy > 0) {
        traitParts.push(`avg ${group.traits.avgImportedBy.toFixed(0)} importers`);
      }
      if (group.traits.commonImports.length > 0) {
        traitParts.push(`shared deps: ${group.traits.commonImports.slice(0, 3).map((f) => `\`${f}\``).join(", ")}`);
      }
      if (traitParts.length > 0) {
        lines.push(`  ${traitParts.join("; ")}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Estimate token savings from typification.
 * Compares the typified rendering against the traditional individual rendering.
 */
export function estimateTypificationSavings(
  result: TypificationResult,
  instabilityMap: Map<string, number>,
): { typifiedTokens: number; traditionalTokens: number; savedTokens: number; savedPct: number } {
  // Rough estimate: each individual table row costs ~25-30 tokens
  const totalFiles = result.ungrouped.length +
    result.groups.reduce((sum, g) => sum + g.members.length + g.exceptions.length, 0);
  const traditionalTokens = totalFiles * 28; // ~28 tokens per table row

  // Each group costs ~20 tokens for the header + ~5 tokens per member filename
  const groupTokens = result.groups.reduce(
    (sum, g) => sum + 20 + g.members.length * 5 + g.exceptions.length * 28,
    0,
  );
  const typifiedTokens = result.ungrouped.length * 28 + groupTokens;

  const savedTokens = traditionalTokens - typifiedTokens;
  const savedPct = traditionalTokens > 0 ? (savedTokens / traditionalTokens) * 100 : 0;

  return { typifiedTokens, traditionalTokens, savedTokens, savedPct };
}

// ── Internal helpers ─────────────────────────────────────────────────

function buildImportMap(edges: ImportEdge[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.isExternal) continue;
    const set = map.get(e.from) ?? new Set();
    set.add(e.to);
    map.set(e.from, set);
  }
  return map;
}

function buildImporterMap(edges: ImportEdge[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.isExternal) continue;
    const set = map.get(e.to) ?? new Set();
    set.add(e.from);
    map.set(e.to, set);
  }
  return map;
}

function computeTraits(
  members: HubFile[],
  importMap: Map<string, Set<string>>,
  importerMap: Map<string, Set<string>>,
): GroupTraits {
  const avgAuthority = members.reduce((s, m) => s + m.authority, 0) / members.length;
  const avgImportedBy = members.reduce((s, m) => s + m.importedBy, 0) / members.length;

  // Find imports shared by majority (>50%) of members
  const importCounts = new Map<string, number>();
  for (const m of members) {
    const imports = importMap.get(m.path) ?? new Set();
    for (const imp of imports) {
      importCounts.set(imp, (importCounts.get(imp) ?? 0) + 1);
    }
  }
  const majorityThreshold = members.length / 2;
  const commonImports = [...importCounts.entries()]
    .filter(([, count]) => count >= majorityThreshold)
    .sort((a, b) => b[1] - a[1])
    .map(([file]) => file);

  // Find importers shared by majority of members
  const importerCounts = new Map<string, number>();
  for (const m of members) {
    const importers = importerMap.get(m.path) ?? new Set();
    for (const imp of importers) {
      importerCounts.set(imp, (importerCounts.get(imp) ?? 0) + 1);
    }
  }
  const commonImporters = [...importerCounts.entries()]
    .filter(([, count]) => count >= majorityThreshold)
    .sort((a, b) => b[1] - a[1])
    .map(([file]) => file);

  return { avgAuthority, avgImportedBy, commonImports, commonImporters };
}

function buildGroupLabel(directory: string, role: FileRole, count: number): string {
  const dirName = directory === "." ? "root" : `\`${directory}/\``;

  // Use role-specific language
  switch (role) {
    case "Foundation":
      return `${count} foundation files in ${dirName}`;
    case "Orchestrator":
      return `${count} orchestrator files in ${dirName}`;
    case "Leaf":
      return `${count} leaf files in ${dirName}`;
    case "Utility":
      return `${count} utility files in ${dirName}`;
    case "Bridge":
      return `${count} bridge files in ${dirName}`;
    case "Barrel":
      return `${count} barrel files in ${dirName}`;
    default:
      return `${count} files in ${dirName}`;
  }
}
