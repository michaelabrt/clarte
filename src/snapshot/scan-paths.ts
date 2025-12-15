import type { DetectedContext, Language, SnapshotEntry } from "../types.js";
import { readFileOr } from "../utils.js";
import { extractSnapshotAst } from "../parsers/extract-snapshot.js";

export function getDefaultScanPaths(ctx: DetectedContext): string[] {
  switch (ctx.language) {
    case "python":
      return getDefaultPythonScanPaths(ctx);
    case "go":
      return getDefaultGoScanPaths(ctx);
    case "rust":
      return getDefaultRustScanPaths(ctx);
    case "java":
      return getDefaultJavaScanPaths(ctx);
    default:
      return getDefaultJsTsScanPaths(ctx);
  }
}

function getDefaultJsTsScanPaths(ctx: DetectedContext): string[] {
  const paths: string[] = [];
  const dirs = ctx.directories;

  for (const d of dirs) {
    if (d.endsWith("types") || d.endsWith("typings")) paths.push(d);
  }
  for (const d of dirs) {
    if (d.endsWith("stores") || d.endsWith("store")) paths.push(d);
  }
  for (const d of dirs) {
    if (d.endsWith("services") || d.endsWith("api")) paths.push(d);
  }
  for (const d of dirs) {
    if (d.endsWith("hooks")) paths.push(d);
  }
  for (const d of dirs) {
    if (d.endsWith("components")) paths.push(d);
  }
  for (const d of dirs) {
    if (d.endsWith("lib") || d.endsWith("utils")) paths.push(d);
  }

  if (paths.length === 0) {
    paths.push("src", "app", "lib");
  }

  return paths;
}

function getDefaultPythonScanPaths(ctx: DetectedContext): string[] {
  const paths: string[] = [];
  const dirs = ctx.directories;

  for (const d of dirs) {
    const last = d.split("/").pop() ?? d;
    if (
      ["models", "schemas", "types", "services", "api", "core", "utils", "db", "routes", "routers", "views"].includes(
        last,
      )
    ) {
      paths.push(d);
    }
  }

  if (paths.length === 0) {
    paths.push("src", "app", "lib", ".");
  }

  return paths;
}

export function getDefaultScanPathsForLanguage(lang: Language, ctx: DetectedContext): string[] {
  switch (lang) {
    case "python":
      return getDefaultPythonScanPaths(ctx);
    case "go":
      return getDefaultGoScanPaths(ctx);
    case "rust":
      return getDefaultRustScanPaths(ctx);
    case "java":
      return getDefaultJavaScanPaths(ctx);
    default:
      return getDefaultJsTsScanPaths(ctx);
  }
}

export function getLanguageConfig(lang: Language): {
  glob: string;
  extractor: (filePath: string, relPath: string) => Promise<SnapshotEntry[]>;
  ignore: string[];
} {
  switch (lang) {
    case "python":
      return {
        glob: "**/*.py",
        extractor: makeExtractor("python"),
        ignore: [
          "**/__pycache__/**",
          "**/venv/**",
          "**/.venv/**",
          "**/env/**",
          "**/migrations/**",
          "**/test_*.py",
          "**/tests/**",
          "**/conftest.py",
          "**/setup.py",
        ],
      };
    case "go":
      return {
        glob: "**/*.go",
        extractor: makeExtractor("go"),
        ignore: ["**/*_test.go", "**/vendor/**", "**/testdata/**"],
      };
    case "rust":
      return {
        glob: "**/*.rs",
        extractor: makeExtractor("rust"),
        ignore: ["**/target/**", "**/tests/**", "**/*.pb.rs"],
      };
    case "java":
      return {
        glob: "**/*.java",
        extractor: makeExtractor("java"),
        ignore: ["**/target/**", "**/build/**", "**/src/test/**", "**/*Test.java", "**/*Spec.java"],
      };
    default:
      return {
        glob: "**/*.{ts,tsx,js,jsx}",
        extractor: makeExtractor(lang),
        ignore: [],
      };
  }
}

function getDefaultGoScanPaths(ctx: DetectedContext): string[] {
  const paths: string[] = [];
  const dirs = ctx.directories;

  for (const d of dirs) {
    const last = d.split("/").pop() ?? d;
    if (
      ["models", "handlers", "services", "api", "internal", "pkg", "cmd", "server", "domain", "repository"].includes(
        last,
      )
    ) {
      paths.push(d);
    }
  }

  if (paths.length === 0) {
    paths.push(".", "internal", "pkg", "cmd");
  }

  return paths;
}

function getDefaultRustScanPaths(ctx: DetectedContext): string[] {
  const paths: string[] = [];
  const dirs = ctx.directories;

  for (const d of dirs) {
    const last = d.split("/").pop() ?? d;
    if (["src", "lib", "api", "models", "handlers", "services", "domain"].includes(last)) {
      paths.push(d);
    }
  }

  if (paths.length === 0) {
    paths.push("src");
  }

  return paths;
}

function getDefaultJavaScanPaths(ctx: DetectedContext): string[] {
  const paths: string[] = [];
  const dirs = ctx.directories;

  for (const d of dirs) {
    const last = d.split("/").pop() ?? d;
    if (["controllers", "services", "repositories", "models", "entities", "dto", "domain"].includes(last)) {
      paths.push(d);
    }
  }

  if (dirs.some((d) => d === "src" || d.startsWith("src/"))) {
    paths.push("src/main/java");
  }

  if (paths.length === 0) {
    paths.push("src/main/java", "src");
  }

  return paths;
}

export function makeExtractor(lang: Language) {
  return async (filePath: string, relPath: string): Promise<SnapshotEntry[]> => {
    const content = await readFileOr(filePath);
    if (!content) return [];
    return extractSnapshotAst(content, relPath, lang);
  };
}
