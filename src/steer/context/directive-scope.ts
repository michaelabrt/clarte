/**
 * Extract file paths from directives and group by directory scope.
 * Used by scoped rules and enriched hooks delivery modes.
 */

/** A directive with its mentioned files and assigned scope */
export interface ScopedDirective {
  text: string;
  mentionedFiles: string[];
  /** Second-level directory scope (e.g. "src/core"), or null for global */
  primaryScope: string | null;
}

/** Extract backtick-quoted file paths from a directive string. */
export function extractMentionedFiles(directive: string): string[] {
  const matches = directive.matchAll(/`([^`]+\.[a-zA-Z]{1,5})`/g);
  const files: string[] = [];
  for (const m of matches) {
    if (m[1].includes("/")) {
      files.push(m[1]);
    }
  }
  return files;
}

/**
 * Assign a directory scope based on mentioned file paths.
 * Uses the second-level directory under src/ (e.g. "src/core"),
 * or first-level for other paths. Returns null if files span 3+ directories.
 */
export function assignScope(mentionedFiles: string[]): string | null {
  if (mentionedFiles.length === 0) return null;

  const dirs = new Set<string>();
  for (const file of mentionedFiles) {
    const parts = file.split("/");
    if (parts[0] === "src" && parts.length >= 3) {
      dirs.add(`${parts[0]}/${parts[1]}`);
    } else if (parts.length >= 2) {
      dirs.add(parts[0]);
    }
  }

  if (dirs.size === 0) return null;
  if (dirs.size >= 3) return null;
  // When 1-2 directories, pick the first one alphabetically
  return [...dirs].sort()[0];
}

/** Group directives by their primary scope. null key = global. */
export function groupDirectivesByScope(directives: string[]): Map<string | null, ScopedDirective[]> {
  const groups = new Map<string | null, ScopedDirective[]>();

  for (const text of directives) {
    const mentionedFiles = extractMentionedFiles(text);
    const primaryScope = assignScope(mentionedFiles);

    const scoped: ScopedDirective = { text, mentionedFiles, primaryScope };
    const list = groups.get(primaryScope) ?? [];
    list.push(scoped);
    groups.set(primaryScope, list);
  }

  return groups;
}

/** Invert directive-to-files into a per-file lookup of matching directives. */
export function buildFileDirectiveMap(directives: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();

  for (const text of directives) {
    const files = extractMentionedFiles(text);
    for (const file of files) {
      const list = map.get(file) ?? [];
      list.push(text);
      map.set(file, list);
    }
  }

  return map;
}
