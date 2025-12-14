import path from "node:path";
import { glob } from "tinyglobby";
import type { DetectedContext, Language } from "../types.js";

/** Minimum fraction of source files for a language to qualify as secondary (15%) */
export const SECONDARY_LANGUAGE_THRESHOLD = 0.15;

export function getExtensionsForLanguage(lang: Language): string[] {
  switch (lang) {
    case "typescript":
      return [".ts", ".tsx"];
    case "javascript":
      return [".js", ".jsx", ".mjs"];
    case "python":
      return [".py"];
    case "go":
      return [".go"];
    case "rust":
      return [".rs"];
    case "java":
      return [".java"];
    default:
      return [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"];
  }
}

/** Extension to language mapping for secondary language detection */
const EXT_TO_LANGUAGE: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
};

/**
 * Detect secondary languages in the project.
 * Populates `ctx.languageBreakdown` and `ctx.secondaryLanguages`.
 * Returns the full list of source files found (reusable for primary language counting).
 */
export async function detectLanguageBreakdown(ctx: DetectedContext, rootDir: string): Promise<string[]> {
  if (ctx.language === "other") return [];

  try {
    const allSourceFiles = await glob(
      ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.py", "**/*.go", "**/*.rs", "**/*.java"],
      {
        cwd: rootDir,
        ignore: [
          "**/node_modules/**",
          "**/dist/**",
          "**/build/**",
          "**/.next/**",
          "**/target/**",
          "**/vendor/**",
          "**/__pycache__/**",
          "**/venv/**",
          "**/.venv/**",
          "**/.Trash/**",
          "**/Library/**",
          "**/.git/**",
        ],
      },
    );

    if (allSourceFiles.length === 0) return [];

    const counts: Record<string, number> = {};
    for (const file of allSourceFiles) {
      const ext = path.extname(file).toLowerCase();
      const lang = EXT_TO_LANGUAGE[ext];
      if (lang) {
        counts[lang] = (counts[lang] ?? 0) + 1;
      }
    }

    if (ctx.language === "typescript" && counts["javascript"]) {
      counts["typescript"] = (counts["typescript"] ?? 0) + counts["javascript"];
      delete counts["javascript"];
    }

    ctx.languageBreakdown = counts;

    const totalFiles = allSourceFiles.length;
    const threshold = totalFiles * SECONDARY_LANGUAGE_THRESHOLD;
    const secondary: Language[] = [];

    for (const [lang, count] of Object.entries(counts)) {
      if (lang !== ctx.language && count >= threshold) {
        secondary.push(lang as Language);
      }
    }

    if (secondary.length > 0) {
      ctx.secondaryLanguages = secondary;
    }

    return allSourceFiles;
  } catch {
    return [];
  }
}
