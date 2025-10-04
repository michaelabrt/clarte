import path from "node:path";
import type { ProjectConfig } from "./types.js";
import { fileExists, readFileOr } from "./utils.js";
import { getMainContextFilename } from "./templates/main-context.js";

/**
 * Regex to extract backtick-quoted file paths from markdown content.
 * Matches paths that contain at least one slash and end with a known file extension.
 */
const BACKTICK_PATH_RE = /`([^`\s]+\/[^`\s]+\.(?:ts|tsx|js|jsx|py|go|rs|java|json|md|yaml|yml|toml))`/g;

/**
 * Extract file paths from backtick-quoted references in markdown content.
 * Only matches paths containing at least one `/` and ending with a known extension.
 */
export function extractFilePaths(content: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  // Reset regex state
  BACKTICK_PATH_RE.lastIndex = 0;
  while ((match = BACKTICK_PATH_RE.exec(content)) !== null) {
    const filePath = match[1];
    if (!seen.has(filePath)) {
      seen.add(filePath);
      paths.push(filePath);
    }
  }

  return paths;
}

/**
 * Validate that backtick-quoted file paths in the generated context file exist on disk.
 * Returns broken paths and the file that was checked, or null if the context file does not exist.
 */
export async function validateContextPaths(
  rootDir: string,
  config: ProjectConfig,
): Promise<{ broken: string[]; file: string } | null> {
  const ide = config.ides?.[0] ?? "claude";
  const contextFile = getMainContextFilename(ide);
  const contextPath = path.join(rootDir, contextFile);

  const content = await readFileOr(contextPath);
  if (!content) return null;

  const referencedPaths = extractFilePaths(content);
  const broken: string[] = [];

  for (const ref of referencedPaths) {
    const absPath = path.join(rootDir, ref);
    const exists = await fileExists(absPath);
    if (!exists) {
      broken.push(ref);
    }
  }

  return { broken, file: contextFile };
}
