// Integration: call validateAndReport() after generateFiles() in index.ts
// For --check mode: call validateContextFile() and fail on errors

import fs from "node:fs/promises";
import path from "node:path";
import type { ImportGraph } from "./types.js";

/** A single validation warning or error */
export interface ValidationWarning {
  section: string;
  message: string;
  severity: "error" | "warning";
}

/** Result of validating a context file */
export interface ValidationResult {
  valid: boolean;
  warnings: ValidationWarning[];
}

/**
 * Regex to match backtick-quoted paths that look like source files.
 * Matches paths containing a "/" and a file extension, or starting with
 * common source directories (src/, lib/, packages/).
 */
const BACKTICK_PATH_RE = /`((?:src|lib|packages|app|apps|test|tests|__tests__)\/[^\s`]+\.\w+|[^\s`]*\/[^\s`]+\.\w{1,5})`/g;

/**
 * Patterns to exclude from path validation (URLs, commands, non-path content).
 */
function isLikelyPath(candidate: string): boolean {
  // Skip URLs
  if (/^https?:\/\//.test(candidate)) return false;
  // Skip npm/shell commands
  if (/^(npm|npx|yarn|pnpm|bun|node|git|pip)\s/.test(candidate)) return false;
  // Skip glob patterns with wildcards
  if (candidate.includes("*")) return false;
  // Must have a file extension
  if (!/\.\w{1,5}$/.test(candidate)) return false;
  // Must contain a slash (relative path)
  if (!candidate.includes("/")) return false;
  return true;
}

/** Regex for table rows like "| `src/types.ts` | 20 files |" */
const IMPORT_COUNT_TABLE_RE = /\|\s*`([^`]+)`\s*\|\s*(\d+)\s*files?\s*\|/g;

/**
 * Extract claimed import counts from context file content.
 * Returns an array of { path, claimedCount } pairs.
 */
function extractImportClaims(content: string): Array<{ path: string; claimedCount: number }> {
  const claims: Array<{ path: string; claimedCount: number }> = [];
  const seen = new Set<string>();

  // Pattern 1: inline "imported by N files" near a backtick path
  // We scan line by line for lines that contain both a path and an import count
  const lines = content.split("\n");
  for (const line of lines) {
    const pathMatch = line.match(/`([^`]+\.\w{1,5})`/);
    const countMatch = line.match(/imported by (\d+) files?/i) || line.match(/Imported By[:\s|]*(\d+)/i);
    if (pathMatch && countMatch) {
      const filePath = pathMatch[1];
      const count = parseInt(countMatch[1], 10);
      if (!seen.has(filePath) && !isNaN(count)) {
        seen.add(filePath);
        claims.push({ path: filePath, claimedCount: count });
      }
    }
  }

  // Pattern 2: table rows like "| `src/types.ts` | 20 files |"
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = IMPORT_COUNT_TABLE_RE.exec(content)) !== null) {
    const filePath = tableMatch[1];
    const count = parseInt(tableMatch[2], 10);
    if (!seen.has(filePath) && !isNaN(count)) {
      seen.add(filePath);
      claims.push({ path: filePath, claimedCount: count });
    }
  }

  return claims;
}

/**
 * Check if the content contains a snapshot section.
 * Returns the section text if found, null otherwise.
 */
function findSnapshotSection(content: string): boolean {
  return content.includes("## Code Snapshot") || content.includes("CODE SNAPSHOT");
}

/**
 * Extract framework names from the "Tech Stack" section of a context file.
 * The Tech Stack section typically appears as a markdown section listing frameworks.
 */
function extractTechStackFrameworks(content: string): string[] {
  const frameworks: string[] = [];

  // Find the Tech Stack section (## Tech Stack or similar)
  const techStackMatch = content.match(/##\s*Tech Stack\s*\n([\s\S]*?)(?=\n##\s|\n---|\z)/);
  if (!techStackMatch) return frameworks;

  const section = techStackMatch[1];

  // Extract framework names from bold items or list items
  // Pattern: "- **Framework Name** X.Y.Z" or "- **Framework Name**"
  const boldRe = /[-*]\s+\*\*([^*]+)\*\*/gm;
  // Fallback: "- Framework X.Y.Z" (no bold)
  const plainRe = /[-*]\s+([A-Za-z][\w./ -]+?)(?:\s+\d[\d.]*|\s*$)/gm;

  let match: RegExpExecArray | null;
  const seen = new Set<string>();

  while ((match = boldRe.exec(section)) !== null) {
    const name = match[1].trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      frameworks.push(name);
    }
  }

  // Only try plain pattern if bold found nothing
  if (frameworks.length === 0) {
    while ((match = plainRe.exec(section)) !== null) {
      const name = match[1].trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        frameworks.push(name);
      }
    }
  }

  return frameworks;
}

/**
 * Validate a generated context file for correctness.
 *
 * Checks:
 * 1. Path verification: backtick-quoted paths exist on disk
 * 2. Import count consistency: claimed import counts match graph data
 * 3. Snapshot freshness: warns if snapshot is older than 7 days
 * 4. Dead reference detection: frameworks in Tech Stack but absent elsewhere
 */
export async function validateContextFile(
  content: string,
  rootDir: string,
  graph?: ImportGraph,
): Promise<ValidationResult> {
  const warnings: ValidationWarning[] = [];

  // 1. Path verification
  await verifyPaths(content, rootDir, warnings);

  // 2. Import count consistency
  if (graph) {
    verifyImportCounts(content, graph, warnings);
  }

  // 3. Snapshot freshness
  checkSnapshotFreshness(content, warnings);

  // 4. Dead reference detection
  checkDeadReferences(content, warnings);

  return {
    valid: warnings.filter((w) => w.severity === "error").length === 0,
    warnings,
  };
}

/**
 * Verify that backtick-quoted paths in the content exist on disk.
 */
async function verifyPaths(
  content: string,
  rootDir: string,
  warnings: ValidationWarning[],
): Promise<void> {
  const paths = new Set<string>();
  let match: RegExpExecArray | null;

  // Reset regex state
  BACKTICK_PATH_RE.lastIndex = 0;
  while ((match = BACKTICK_PATH_RE.exec(content)) !== null) {
    const candidate = match[1];
    if (isLikelyPath(candidate)) {
      paths.add(candidate);
    }
  }

  for (const relPath of paths) {
    const fullPath = path.join(rootDir, relPath);
    try {
      await fs.access(fullPath);
    } catch {
      warnings.push({
        section: "paths",
        message: `Referenced path does not exist: ${relPath}`,
        severity: "warning",
      });
    }
  }
}

/**
 * Verify that "imported by N files" claims match actual graph inDegree data.
 * Allows +/-1 tolerance to account for slight graph changes.
 */
function verifyImportCounts(
  content: string,
  graph: ImportGraph,
  warnings: ValidationWarning[],
): void {
  const claims = extractImportClaims(content);

  for (const { path: filePath, claimedCount } of claims) {
    const actual = graph.inDegree.get(filePath);
    if (actual === undefined) continue; // File not in graph, skip

    const diff = Math.abs(claimedCount - actual);
    if (diff > 1) {
      warnings.push({
        section: "import-counts",
        message: `Import count mismatch for ${filePath}: claimed ${claimedCount}, actual ${actual}`,
        severity: "warning",
      });
    }
  }
}

/**
 * Check if the snapshot section exists and whether a snapshotGeneratedAt
 * timestamp indicates staleness (older than 7 days).
 */
function checkSnapshotFreshness(
  content: string,
  warnings: ValidationWarning[],
): void {
  if (!findSnapshotSection(content)) return;

  // Look for snapshotGeneratedAt in the content (may appear as a comment or metadata)
  const timestampMatch = content.match(/snapshotGeneratedAt[:\s]*(\d{13,})/);
  if (!timestampMatch) return;

  const generatedAt = parseInt(timestampMatch[1], 10);
  if (isNaN(generatedAt)) return;

  const ageMs = Date.now() - generatedAt;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (ageDays > 7) {
    warnings.push({
      section: "snapshot-freshness",
      message: `Code snapshot is ${Math.floor(ageDays)} days old (generated ${new Date(generatedAt).toISOString().slice(0, 10)}). Consider regenerating.`,
      severity: "warning",
    });
  }
}

/**
 * Check if any framework mentioned in the "Tech Stack" section is missing
 * from the rest of the content (framework hints, key patterns, etc.).
 */
function checkDeadReferences(
  content: string,
  warnings: ValidationWarning[],
): void {
  const techStackFrameworks = extractTechStackFrameworks(content);
  if (techStackFrameworks.length === 0) return;

  // Find the Tech Stack section boundaries so we can check the rest of the content
  const techStackStart = content.indexOf("## Tech Stack");
  if (techStackStart === -1) return;

  // Find the end of the Tech Stack section
  const nextSectionMatch = content.slice(techStackStart + 1).match(/\n## /);
  const techStackEnd = nextSectionMatch
    ? techStackStart + 1 + nextSectionMatch.index!
    : content.length;

  const restOfContent =
    content.slice(0, techStackStart) + content.slice(techStackEnd);

  for (const framework of techStackFrameworks) {
    // Check if the framework name appears anywhere else in the content
    // Use case-insensitive search and allow partial matches (e.g. "React" matches "React Native")
    if (!restOfContent.toLowerCase().includes(framework.toLowerCase())) {
      warnings.push({
        section: "dead-references",
        message: `Framework "${framework}" appears in Tech Stack but is not referenced elsewhere in the file`,
        severity: "warning",
      });
    }
  }
}

/**
 * Validate a context file and print warnings to stderr.
 * Intended to be called after generateFiles() in index.ts.
 */
export async function validateAndReport(
  content: string,
  rootDir: string,
  graph?: ImportGraph,
): Promise<void> {
  const result = await validateContextFile(content, rootDir, graph);

  if (result.warnings.length === 0) return;

  for (const warning of result.warnings) {
    const prefix = warning.severity === "error" ? "ERROR" : "WARN";
    console.warn(`[${prefix}] [${warning.section}] ${warning.message}`);
  }
}
