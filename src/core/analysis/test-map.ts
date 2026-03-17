import path from "node:path";
import type { DetectedContext, ImportGraph, TestMapping, TestType } from "../types";
import { getOrSet, isTestFile } from "../utils";

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

/**
 * E2E path patterns: files in e2e/, playwright/, or cypress/ directories.
 */
const E2E_PATH_PATTERNS = [/(?:^|\/)e2e\//, /(?:^|\/)playwright\//, /(?:^|\/)cypress\//];

/**
 * Integration path patterns: files in integration/ directories.
 */
const INTEGRATION_PATH_PATTERNS = [/(?:^|\/)integration\//];

/**
 * Classify a test file as unit, integration, or e2e.
 *
 * Rules:
 * - e2e: path contains e2e/, playwright/, or cypress/
 * - integration: path contains integration/, or imports 3+ distinct source modules
 * - unit: everything else
 */
export function classifyTestType(testFile: string, sourceImportCount: number): TestType {
  for (const pattern of E2E_PATH_PATTERNS) {
    if (pattern.test(testFile)) return "e2e";
  }

  for (const pattern of INTEGRATION_PATH_PATTERNS) {
    if (pattern.test(testFile)) return "integration";
  }

  // If it imports 3+ distinct source modules, classify as integration
  if (sourceImportCount >= 3) return "integration";

  return "unit";
}

const MONOREPO_PREFIX_PATTERNS = [
  /^(packages\/[^/]+)\//,
  /^(apps\/[^/]+)\//,
  /^(libs\/[^/]+)\//,
  /^(modules\/[^/]+)\//,
];

/**
 * Extract the package prefix from a file path.
 * e.g., "packages/auth/src/login.ts" -> "packages/auth"
 * Returns null if the file does not belong to a recognized monorepo package directory.
 */
function getPackagePrefix(filePath: string): string | null {
  for (const pattern of MONOREPO_PREFIX_PATTERNS) {
    const match = filePath.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Check if the graph contains files from multiple monorepo packages.
 */
function detectMonorepoPackages(files: Set<string>): boolean {
  const packages = new Set<string>();
  for (const file of files) {
    const pkg = getPackagePrefix(file);
    if (pkg) packages.add(pkg);
    if (packages.size >= 2) return true;
  }
  return false;
}

/**
 * Build a mapping from source files to their test files by analyzing the import graph.
 *
 * For each test file in the graph, follows its internal import edges to find
 * the source files it covers. Builds a reverse map: sourceFile -> testFile[].
 * Also identifies source files with no test coverage.
 */
export function buildTestMapping(graph: ImportGraph, ctx: DetectedContext): TestMapping | null {
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

  const testImports = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (!testFiles.has(edge.from)) continue;
    if (!sourceFiles.has(edge.to)) continue;

    getOrSet(testImports, edge.from, () => new Set<string>()).add(edge.to);
  }

  const isMonorepo = detectMonorepoPackages(allFiles);

  // In monorepo mode, only count tests from the same package as coverage
  const sourceToTests = new Map<string, string[]>();

  for (const [testFile, imports] of testImports) {
    const testPkg = isMonorepo ? getPackagePrefix(testFile) : null;

    for (const sourceFile of imports) {
      if (isMonorepo) {
        const sourcePkg = getPackagePrefix(sourceFile);
        if (testPkg !== null && sourcePkg !== null && testPkg !== sourcePkg) {
          continue;
        }
      }

      getOrSet(sourceToTests, sourceFile, () => [] as string[]).push(testFile);
    }
  }

  // Sort test arrays for determinism
  for (const tests of sourceToTests.values()) {
    tests.sort();
  }

  // Build source->source out-edges for transitive coverage
  const sourceOutEdges = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (!sourceFiles.has(edge.from) || !sourceFiles.has(edge.to)) continue;
    getOrSet(sourceOutEdges, edge.from, () => new Set<string>()).add(edge.to);
  }

  // Extend coverage transitively: if a source file is directly tested,
  // files it imports (up to N hops) are also considered covered.
  const TRANSITIVE_DEPTH = 3;
  const transitivelyCovered = new Set<string>(sourceToTests.keys());

  let frontier = new Set<string>(sourceToTests.keys());
  for (let depth = 0; depth < TRANSITIVE_DEPTH && frontier.size > 0; depth++) {
    const nextFrontier = new Set<string>();
    for (const file of frontier) {
      const targets = sourceOutEdges.get(file);
      if (!targets) continue;
      for (const target of targets) {
        if (!transitivelyCovered.has(target) && sourceFiles.has(target)) {
          transitivelyCovered.add(target);
          nextFrontier.add(target);
        }
      }
    }
    frontier = nextFrontier;
  }

  // Find untested source files
  // A source file is "untested" if:
  // 1. It's not imported by any test file (directly or transitively)
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
    if (transitivelyCovered.has(file)) continue;
    if (!importedByNonTest.has(file)) continue;
    if (isExcludedFromUntested(file)) continue;
    untestedFiles.push(file);
  }
  // Sort by import count (most-imported first) so the most important untested
  // files appear before the display limit truncates the list
  untestedFiles.sort((a, b) => {
    const aCount = graph.inDegree.get(a) ?? 0;
    const bCount = graph.inDegree.get(b) ?? 0;
    if (bCount !== aCount) return bCount - aCount;
    return a.localeCompare(b);
  });

  // Detect test pattern
  const testPattern = detectTestPattern(testFiles, ctx);

  // Classify test types
  const testTypes = new Map<string, TestType>();
  for (const testFile of testFiles) {
    const sourceImports = testImports.get(testFile);
    const sourceImportCount = sourceImports ? sourceImports.size : 0;
    testTypes.set(testFile, classifyTestType(testFile, sourceImportCount));
  }

  // Find exemplar test file (most source imports) as a pattern reference
  let exemplarTestFile: string | undefined;
  let maxImports = 0;
  for (const [testFile, imports] of testImports) {
    if (imports.size > maxImports) {
      maxImports = imports.size;
      exemplarTestFile = testFile;
    }
  }

  return {
    sourceToTests,
    untestedFiles,
    testPattern,
    testTypes,
    exemplarTestFile,
  };
}

/**
 * Render the test coverage map as a markdown section.
 * Includes per-source-file directives (hub files first) and untested file warnings.
 */
export function renderTestMappingSection(mapping: TestMapping, hubFiles?: Array<{ path: string }>): string | null {
  const lines: string[] = [];

  // Render directives for ALL source files with tests, hub files first
  const hubSet = new Set(hubFiles?.map((h) => h.path) ?? []);
  const testedFiles = Array.from(mapping.sourceToTests.keys()).sort((a, b) => {
    const aHub = hubSet.has(a) ? 0 : 1;
    const bHub = hubSet.has(b) ? 0 : 1;
    if (aHub !== bHub) return aHub - bHub;
    return a.localeCompare(b);
  });

  const directives: string[] = [];
  for (const sourceFile of testedFiles) {
    const tests = mapping.sourceToTests.get(sourceFile) ?? [];
    const testList = tests
      .map((t) => {
        const typeLabel = mapping.testTypes?.get(t);
        return typeLabel ? `\`${t}\` (${typeLabel})` : `\`${t}\``;
      })
      .join(", ");
    directives.push(`- **Must**: When modifying \`${sourceFile}\`, run its tests: ${testList}`);
  }
  if (directives.length > 0) {
    lines.push(...directives);
  }

  if (mapping.untestedFiles.length > 0) {
    const displayed = mapping.untestedFiles.slice(0, 15);
    const fileList = displayed.map((f) => `\`${f}\``).join(", ");
    lines.push(`- **Prefer**: Add tests for uncovered files: ${fileList}`);
    if (mapping.untestedFiles.length > 15) {
      lines.push(`  (${mapping.untestedFiles.length - 15} more untested files)`);
    }
  }

  if (mapping.exemplarTestFile) {
    lines.push(
      `- **Prefer**: Follow existing test patterns in \`${mapping.exemplarTestFile}\` (most comprehensive test file)`,
    );
  }

  if (mapping.testPattern) {
    lines.push(
      `- **Style**: Test convention: ${mapping.testPattern.convention} (\`${mapping.testPattern.filePattern}\`)`,
    );
  }

  if (lines.length === 0) return null;

  return "## Test Coverage Map\n\n" + lines.join("\n");
}

function detectTestPattern(testFiles: Set<string>, ctx: DetectedContext): TestMapping["testPattern"] {
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
