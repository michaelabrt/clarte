import path from "node:path";
import type { DetectedContext, ImportGraph, TestMapping } from "./types.js";

// ── Test file detection ────────────────────────────────────────────────

const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.[jt]sx?$/,
  /\.(test|spec)\.(ts|js)$/,
  /__tests__\//,
  /_test\.go$/,
  /_test\.py$/,
  /test_[^/]+\.py$/,
  /tests\/[^/]+\.py$/,
];

function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

// ── Files to exclude from "untested" ──────────────────────────────────

function isExcludedFromUntested(filePath: string): boolean {
  const basename = path.basename(filePath);

  // Type/interface-only files
  if (/(?:^|\/)types?\//.test(filePath) || /(?:^|\/)interfaces?\//.test(filePath)) return true;
  if (basename === "types.ts" || basename === "types.d.ts") return true;

  // Config files
  if (/\.(config|rc)\.[jt]sx?$/.test(basename)) return true;
  if (basename.startsWith(".")) return true;

  // Barrel/index files
  if (/^index\.[jt]sx?$/.test(basename)) return true;

  // Entry points
  if (/^(main|app|server|cli)\.[jt]sx?$/.test(basename)) return true;
  if (basename === "mod.ts" || basename === "lib.rs" || basename === "main.rs") return true;
  if (basename === "main.go" || basename === "main.py") return true;

  // Test helpers/fixtures
  if (filePath.includes("__fixtures__/") || filePath.includes("__mocks__/")) return true;
  if (filePath.includes("test-utils") || filePath.includes("test-helpers")) return true;

  // Generated files
  if (filePath.includes("generated/") || filePath.includes(".gen.")) return true;

  return false;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Build a mapping from source files to their test files by analyzing the import graph.
 *
 * For each test file in the graph, follows its internal import edges to find
 * the source files it covers. Builds a reverse map: sourceFile -> testFile[].
 * Also identifies source files with no test coverage.
 */
export function buildTestMapping(
  graph: ImportGraph,
  ctx: DetectedContext,
): TestMapping | null {
  // Collect all files and separate test files from source files
  const allFiles = new Set<string>();
  const testFiles = new Set<string>();
  const sourceFiles = new Set<string>();

  for (const [file] of graph.inDegree) {
    allFiles.add(file);
    if (isTestFile(file)) {
      testFiles.add(file);
    } else {
      sourceFiles.add(file);
    }
  }

  if (testFiles.size === 0) {
    return null;
  }

  // Build adjacency list for test file imports (outgoing edges from test files)
  const testImports = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (!testFiles.has(edge.from)) continue;
    if (!sourceFiles.has(edge.to)) continue;

    if (!testImports.has(edge.from)) testImports.set(edge.from, new Set());
    testImports.get(edge.from)!.add(edge.to);
  }

  // Build reverse map: sourceFile -> testFile[]
  const sourceToTests = new Map<string, string[]>();

  for (const [testFile, imports] of testImports) {
    for (const sourceFile of imports) {
      if (!sourceToTests.has(sourceFile)) sourceToTests.set(sourceFile, []);
      sourceToTests.get(sourceFile)!.push(testFile);
    }
  }

  // Sort test arrays for determinism
  for (const tests of sourceToTests.values()) {
    tests.sort();
  }

  // Find untested source files
  // A source file is "untested" if:
  // 1. It's not imported by any test file
  // 2. It IS imported by at least one non-test file (has some purpose)
  // 3. It's not excluded (types, config, barrels, etc.)
  const importedByNonTest = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (!testFiles.has(edge.from) && sourceFiles.has(edge.to)) {
      importedByNonTest.add(edge.to);
    }
  }

  const untestedFiles: string[] = [];
  for (const file of sourceFiles) {
    if (sourceToTests.has(file)) continue;
    if (!importedByNonTest.has(file)) continue;
    if (isExcludedFromUntested(file)) continue;
    untestedFiles.push(file);
  }
  untestedFiles.sort();

  // Detect test pattern
  const testPattern = detectTestPattern(testFiles, ctx);

  return {
    sourceToTests,
    untestedFiles,
    testPattern,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────

/**
 * Render the test coverage map as a markdown section.
 * Includes per-hub-file directives and untested file warnings.
 */
export function renderTestMappingSection(
  mapping: TestMapping,
  hubFiles?: Array<{ path: string }>,
): string | null {
  const lines: string[] = [];

  // Hub file test directives
  if (hubFiles && hubFiles.length > 0) {
    const directives: string[] = [];
    for (const hub of hubFiles) {
      const tests = mapping.sourceToTests.get(hub.path);
      if (tests && tests.length > 0) {
        const testList = tests.map((t) => `\`${t}\``).join(", ");
        directives.push(`- **Must**: When modifying \`${hub.path}\`, run its tests: ${testList}`);
      }
    }
    if (directives.length > 0) {
      lines.push(...directives);
    }
  }

  // Untested files warning
  if (mapping.untestedFiles.length > 0) {
    const displayed = mapping.untestedFiles.slice(0, 10);
    const fileList = displayed.map((f) => `\`${f}\``).join(", ");
    lines.push(`- **Prefer**: Add tests for uncovered files: ${fileList}`);
    if (mapping.untestedFiles.length > 10) {
      lines.push(`  (${mapping.untestedFiles.length - 10} more untested files)`);
    }
  }

  // Test pattern info
  if (mapping.testPattern) {
    lines.push(`- **Style**: Test convention: ${mapping.testPattern.convention} (\`${mapping.testPattern.filePattern}\`)`);
  }

  if (lines.length === 0) return null;

  return "## Test Coverage Map\n\n" + lines.join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────

function detectTestPattern(
  testFiles: Set<string>,
  ctx: DetectedContext,
): TestMapping["testPattern"] {
  let testCount = 0;
  let specCount = 0;
  let underscoreCount = 0;

  for (const file of testFiles) {
    if (/\.test\.[jt]sx?$/.test(file)) testCount++;
    else if (/\.spec\.[jt]sx?$/.test(file)) specCount++;
    else if (/_test\.(go|py)$/.test(file)) underscoreCount++;
  }

  const framework = ctx.testFramework ?? "unknown";

  if (testCount >= specCount && testCount >= underscoreCount) {
    return {
      framework,
      convention: "co-located .test files",
      filePattern: "*.test.{ts,tsx,js,jsx}",
    };
  }
  if (specCount > testCount && specCount >= underscoreCount) {
    return {
      framework,
      convention: "co-located .spec files",
      filePattern: "*.spec.{ts,tsx,js,jsx}",
    };
  }
  if (underscoreCount > 0) {
    return {
      framework,
      convention: "_test suffix",
      filePattern: ctx.language === "go" ? "*_test.go" : "*_test.py",
    };
  }

  return undefined;
}
