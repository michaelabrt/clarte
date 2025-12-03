/**
 * Parser Parity Test: Regex (main) vs AST (tree-sitter)
 *
 * Runs both the old regex-based import parsers and the new AST-based parsers
 * on the same source files and compares the results. Every divergence is
 * reported so it can be audited before committing to the AST rewrite.
 *
 * Import parsing is the foundation: different edges cascade into different
 * hub files, coupling analysis, chokepoints, and ultimately different CLAUDE.md output.
 *
 * Run: npx vitest run src/__tests__/ast-parity.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initTreeSitter, parseImportsAst, extractSnapshotAst } from "../ast-parse.js";
import type { RawImport } from "../ast-parse.js";
import type { Language } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

// ── Old Regex Parsers (extracted from main:src/graph.ts) ─────────────────────
// These are frozen copies of the regex parsers from the main branch.
// They exist solely for comparison; do not modify them.

// --- Regex patterns ---

const JS_IMPORT_FROM =
  /import\s+(type\s+)?(?:\{([^}]*)\}|(\*\s+as\s+\w+|\w+)(?:\s*,\s*\{([^}]*)\})?)\s+from\s+['"]([^'"]+)['"]/g;
const JS_IMPORT_SIDE = /import\s+['"]([^'"]+)['"]/g;
const JS_REQUIRE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const JS_DYNAMIC = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
const PY_FROM_IMPORT = /^from\s+(\.+[\w.]*|[\w][\w.]*)\s+import\s+(.+)/gm;
const PY_IMPORT = /^import\s+([\w., ]+)/gm;
const GO_IMPORT_SINGLE = /import\s+"([^"]+)"/g;
const GO_IMPORT_BLOCK = /import\s*\(([^)]+)\)/gs;
const RUST_USE = /(?:pub\s+)?use\s+((?:crate|super|self)(?:::\w+)*(?:::\{[^}]*\})?)/g;
const RUST_MOD = /mod\s+(\w+)\s*;/g;
const JAVA_IMPORT = /^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;

// --- Comment stripping ---

function stripCommentsAndStrings(content: string, commentsOnly = false): string {
  let result = "";
  let i = 0;
  const len = content.length;
  while (i < len) {
    const ch = content[i];
    const next = i + 1 < len ? content[i + 1] : "";
    if (ch === "/" && next === "/") {
      result += "  ";
      i += 2;
      while (i < len && content[i] !== "\n") {
        result += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      result += "  ";
      i += 2;
      while (i < len) {
        if (content[i] === "*" && i + 1 < len && content[i + 1] === "/") {
          result += "  ";
          i += 2;
          break;
        }
        result += content[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    if (!commentsOnly) {
      if (ch === "`") {
        result += " ";
        i++;
        let d = 0;
        while (i < len) {
          if (content[i] === "\\" && i + 1 < len) {
            result += "  ";
            i += 2;
            continue;
          }
          if (content[i] === "$" && i + 1 < len && content[i + 1] === "{") {
            result += "  ";
            i += 2;
            d++;
            continue;
          }
          if (d > 0 && content[i] === "}") {
            result += " ";
            i++;
            d--;
            continue;
          }
          if (d === 0 && content[i] === "`") {
            result += " ";
            i++;
            break;
          }
          result += content[i] === "\n" ? "\n" : " ";
          i++;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        const q = ch;
        result += " ";
        i++;
        while (i < len) {
          if (content[i] === "\\" && i + 1 < len) {
            result += "  ";
            i += 2;
            continue;
          }
          if (content[i] === q) {
            result += " ";
            i++;
            break;
          }
          if (content[i] === "\n") break;
          result += " ";
          i++;
        }
        continue;
      }
    } else {
      if (ch === "`") {
        result += ch;
        i++;
        let d = 0;
        while (i < len) {
          result += content[i];
          if (content[i] === "\\" && i + 1 < len) {
            i++;
            result += content[i];
            i++;
            continue;
          }
          if (content[i] === "$" && i + 1 < len && content[i + 1] === "{") {
            i++;
            result += content[i];
            i++;
            d++;
            continue;
          }
          if (d > 0 && content[i] === "}") {
            i++;
            d--;
            continue;
          }
          if (d === 0 && content[i] === "`") {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        const q = ch;
        result += ch;
        i++;
        while (i < len) {
          result += content[i];
          if (content[i] === "\\" && i + 1 < len) {
            i++;
            result += content[i];
            i++;
            continue;
          }
          if (content[i] === q) {
            i++;
            break;
          }
          if (content[i] === "\n") break;
          i++;
        }
        continue;
      }
    }
    result += ch;
    i++;
  }
  return result;
}

function stripPythonComments(content: string): string {
  let result = "";
  let i = 0;
  const len = content.length;
  while (i < len) {
    const ch = content[i];
    if (i + 2 < len) {
      const triple = content.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        result += triple;
        i += 3;
        while (i < len) {
          if (i + 2 < len && content.slice(i, i + 3) === triple) {
            result += triple;
            i += 3;
            break;
          }
          result += content[i];
          i++;
        }
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      const q = ch;
      result += ch;
      i++;
      while (i < len) {
        result += content[i];
        if (content[i] === "\\" && i + 1 < len) {
          i++;
          result += content[i];
          i++;
          continue;
        }
        if (content[i] === q) {
          i++;
          break;
        }
        if (content[i] === "\n") break;
        i++;
      }
      continue;
    }
    if (ch === "#") {
      result += " ";
      i++;
      while (i < len && content[i] !== "\n") {
        result += " ";
        i++;
      }
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

// --- Regex-based parsers ---

function regexParseJsImports(content: string): RawImport[] {
  const cleaned = stripCommentsAndStrings(content, true);
  const imports: RawImport[] = [];
  const fromSpecifiers = new Set<string>();
  for (const m of cleaned.matchAll(JS_IMPORT_FROM)) {
    const isTypeOnly = !!m[1];
    const names: string[] = [];
    if (m[2])
      names.push(
        ...m[2]
          .split(",")
          .map((n) =>
            n
              .trim()
              .split(/\s+as\s+/)[0]
              .trim(),
          )
          .filter(Boolean),
      );
    if (m[3]) {
      const g3 = m[3].trim();
      if (!g3.startsWith("*")) names.push(g3);
    }
    if (m[4])
      names.push(
        ...m[4]
          .split(",")
          .map((n) =>
            n
              .trim()
              .split(/\s+as\s+/)[0]
              .trim(),
          )
          .filter(Boolean),
      );
    fromSpecifiers.add(m[5]);
    imports.push({ specifier: m[5], importedNames: names, isTypeOnly });
  }
  for (const m of cleaned.matchAll(JS_IMPORT_SIDE)) {
    if (!fromSpecifiers.has(m[1])) imports.push({ specifier: m[1], importedNames: [] });
  }
  for (const m of cleaned.matchAll(JS_REQUIRE)) {
    imports.push({ specifier: m[1], importedNames: [] });
  }
  for (const m of cleaned.matchAll(JS_DYNAMIC)) {
    imports.push({ specifier: m[1], importedNames: [], isDynamic: true });
  }
  return imports;
}

function regexParsePythonImports(content: string): RawImport[] {
  const cleaned = stripPythonComments(content);
  const imports: RawImport[] = [];
  for (const m of cleaned.matchAll(PY_FROM_IMPORT)) {
    const module = m[1];
    const names = m[2]
      .split(",")
      .map((n) =>
        n
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter(Boolean);
    imports.push({ specifier: module, importedNames: names });
  }
  for (const m of cleaned.matchAll(PY_IMPORT)) {
    const modules = m[1]
      .split(",")
      .map((n) =>
        n
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter(Boolean);
    for (const mod of modules) imports.push({ specifier: mod, importedNames: [] });
  }
  const lines = cleaned.split("\n");
  const tcRe = /^(\s*)if\s+TYPE_CHECKING\s*:/;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(tcRe);
    if (!match) continue;
    const guardIndent = match[1].length;
    const blockLines: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      const trimmed = line.trimStart();
      if (!trimmed) {
        blockLines.push("");
        continue;
      }
      const lineIndent = line.length - trimmed.length;
      if (lineIndent <= guardIndent) break;
      blockLines.push(trimmed);
    }
    if (blockLines.length === 0) continue;
    const blockContent = blockLines.join("\n");
    for (const m of blockContent.matchAll(PY_FROM_IMPORT)) {
      const module = m[1];
      const names = m[2]
        .split(",")
        .map((n) =>
          n
            .trim()
            .split(/\s+as\s+/)[0]
            .trim(),
        )
        .filter(Boolean);
      imports.push({ specifier: module, importedNames: names, isTypeOnly: true });
    }
    for (const m of blockContent.matchAll(PY_IMPORT)) {
      const modules = m[1]
        .split(",")
        .map((n) =>
          n
            .trim()
            .split(/\s+as\s+/)[0]
            .trim(),
        )
        .filter(Boolean);
      for (const mod of modules) imports.push({ specifier: mod, importedNames: [], isTypeOnly: true });
    }
  }
  return imports;
}

function regexParseGoImports(content: string): RawImport[] {
  const imports: RawImport[] = [];
  for (const m of content.matchAll(GO_IMPORT_SINGLE)) {
    imports.push({ specifier: m[1], importedNames: [] });
  }
  for (const m of content.matchAll(GO_IMPORT_BLOCK)) {
    const block = m[1];
    for (const line of block.split("\n")) {
      if (line.trim().startsWith("//")) continue;
      const match = line.match(/["']([^"']+)["']/);
      if (match) imports.push({ specifier: match[1], importedNames: [] });
    }
  }
  return imports;
}

function regexParseRustImports(content: string): RawImport[] {
  const imports: RawImport[] = [];
  for (const m of content.matchAll(RUST_USE)) {
    const usePath = m[1];
    const globMatch = usePath.match(/::\{([^}]*)\}$/);
    if (globMatch) {
      const names = globMatch[1]
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      imports.push({ specifier: usePath, importedNames: names });
    } else {
      const parts = usePath.split("::");
      const name = parts[parts.length - 1];
      imports.push({ specifier: usePath, importedNames: name ? [name] : [] });
    }
  }
  for (const m of content.matchAll(RUST_MOD)) {
    imports.push({ specifier: m[1], importedNames: [] });
  }
  return imports;
}

function regexParseJavaImports(content: string): RawImport[] {
  const imports: RawImport[] = [];
  for (const m of content.matchAll(JAVA_IMPORT)) {
    const fullPath = m[1];
    const parts = fullPath.split(".");
    const lastName = parts[parts.length - 1];
    const names = lastName === "*" ? [] : [lastName];
    imports.push({ specifier: fullPath, importedNames: names });
  }
  return imports;
}

function regexParseImports(content: string, lang: Language): RawImport[] {
  switch (lang) {
    case "typescript":
    case "javascript":
      return regexParseJsImports(content);
    case "python":
      return regexParsePythonImports(content);
    case "go":
      return regexParseGoImports(content);
    case "rust":
      return regexParseRustImports(content);
    case "java":
      return regexParseJavaImports(content);
    default:
      return regexParseJsImports(content);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize imports for comparison: sort by specifier, sort importedNames, strip undefined fields */
function normalize(imports: RawImport[]): RawImport[] {
  return imports
    .map((imp) => ({
      specifier: imp.specifier,
      importedNames: [...imp.importedNames].sort(),
      ...(imp.isTypeOnly ? { isTypeOnly: true } : {}),
      ...(imp.isDynamic ? { isDynamic: true } : {}),
    }))
    .sort((a, b) => {
      const specCmp = a.specifier.localeCompare(b.specifier);
      if (specCmp !== 0) return specCmp;
      // Same specifier: sort by type-only then by names
      if (a.isTypeOnly !== b.isTypeOnly) return a.isTypeOnly ? 1 : -1;
      return a.importedNames.join(",").localeCompare(b.importedNames.join(","));
    });
}

/** Collect all files with a given extension recursively */
function collectFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
        walk(full);
      } else if (extensions.some((ext) => full.endsWith(ext))) {
        results.push(full);
      }
    }
  };
  walk(dir);
  return results.sort();
}

interface ImportDiff {
  file: string;
  regexOnly: RawImport[];
  astOnly: RawImport[];
  common: number;
}

function diffImports(
  regexImports: RawImport[],
  astImports: RawImport[],
): {
  regexOnly: RawImport[];
  astOnly: RawImport[];
  common: number;
} {
  const regexNorm = normalize(regexImports);
  const astNorm = normalize(astImports);

  const regexSet = new Set(regexNorm.map((i) => JSON.stringify(i)));
  const astSet = new Set(astNorm.map((i) => JSON.stringify(i)));

  const regexOnly = regexNorm.filter((i) => !astSet.has(JSON.stringify(i)));
  const astOnly = astNorm.filter((i) => !regexSet.has(JSON.stringify(i)));
  const common = regexNorm.length - regexOnly.length;

  return { regexOnly, astOnly, common };
}

function langForFile(filePath: string): Language | null {
  const ext = path.extname(filePath);
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
      return "typescript";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
      return "java";
    default:
      return null;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Parser Parity: Regex vs AST", () => {
  beforeAll(async () => {
    await initTreeSitter();
  });

  // ── Import Parsing Parity ──────────────────────────────────────────────

  describe("Import parsing: clarte source files", () => {
    const srcDir = path.join(PROJECT_ROOT, "src");
    const files = collectFiles(srcDir, [".ts", ".tsx"]);

    it("finds source files to test", () => {
      expect(files.length).toBeGreaterThan(20);
    });

    it("compares regex vs AST on all source files", () => {
      const diffs: ImportDiff[] = [];
      let totalFiles = 0;
      let totalCommon = 0;
      let totalRegexOnly = 0;
      let totalAstOnly = 0;

      for (const file of files) {
        const content = readFileSync(file, "utf-8");
        const lang = langForFile(file);
        if (!lang) continue;
        totalFiles++;

        const regexResult = regexParseImports(content, lang);
        const astResult = parseImportsAst(content, lang, file);
        const { regexOnly, astOnly, common } = diffImports(regexResult, astResult);

        totalCommon += common;
        totalRegexOnly += regexOnly.length;
        totalAstOnly += astOnly.length;

        if (regexOnly.length > 0 || astOnly.length > 0) {
          diffs.push({
            file: path.relative(PROJECT_ROOT, file),
            regexOnly,
            astOnly,
            common,
          });
        }
      }

      // Report
      console.log(`\n── Import Parity: clarte src/ ──`);
      console.log(`Files tested: ${totalFiles}`);
      console.log(`Total common imports: ${totalCommon}`);
      console.log(`Regex-only (missed by AST): ${totalRegexOnly}`);
      console.log(`AST-only (missed by regex): ${totalAstOnly}`);

      if (diffs.length > 0) {
        console.log(`\nDivergences in ${diffs.length} files:`);
        for (const d of diffs) {
          console.log(`\n  ${d.file} (${d.common} common)`);
          for (const imp of d.regexOnly) {
            console.log(
              `    REGEX-ONLY: ${imp.specifier} [${imp.importedNames.join(", ")}]${imp.isTypeOnly ? " (type)" : ""}${imp.isDynamic ? " (dynamic)" : ""}`,
            );
          }
          for (const imp of d.astOnly) {
            console.log(
              `    AST-ONLY:   ${imp.specifier} [${imp.importedNames.join(", ")}]${imp.isTypeOnly ? " (type)" : ""}${imp.isDynamic ? " (dynamic)" : ""}`,
            );
          }
        }
      } else {
        console.log("\nPerfect parity: no divergences found.");
      }

      // Record divergences for analysis but don't fail the test;
      // each divergence needs manual audit to determine if it's a
      // regression (AST missing something regex caught) or an
      // improvement (AST catching something regex missed).
      // The assertion below just records the counts for visibility.
      expect({ totalFiles, totalCommon, totalRegexOnly, totalAstOnly, divergentFiles: diffs.length }).toBeDefined();
    });
  });

  describe("Import parsing: fixture files (multi-language)", () => {
    const fixtureDir = path.join(PROJECT_ROOT, "src/__tests__/integration/fixtures");
    const goldenDir = path.join(PROJECT_ROOT, "src/__tests__/golden/fixtures");

    const fixtureFiles = [
      ...collectFiles(fixtureDir, [".ts", ".py", ".go", ".rs", ".java"]),
      ...collectFiles(goldenDir, [".ts"]),
    ];

    it("finds fixture files to test", () => {
      expect(fixtureFiles.length).toBeGreaterThan(10);
    });

    it("compares regex vs AST on all fixture files", () => {
      const diffs: ImportDiff[] = [];
      const langStats = new Map<string, { files: number; common: number; regexOnly: number; astOnly: number }>();

      for (const file of fixtureFiles) {
        const content = readFileSync(file, "utf-8");
        const lang = langForFile(file);
        if (!lang) continue;

        const regexResult = regexParseImports(content, lang);
        const astResult = parseImportsAst(content, lang, file);
        const { regexOnly, astOnly, common } = diffImports(regexResult, astResult);

        const stats = langStats.get(lang) ?? { files: 0, common: 0, regexOnly: 0, astOnly: 0 };
        stats.files++;
        stats.common += common;
        stats.regexOnly += regexOnly.length;
        stats.astOnly += astOnly.length;
        langStats.set(lang, stats);

        if (regexOnly.length > 0 || astOnly.length > 0) {
          diffs.push({
            file: path.relative(PROJECT_ROOT, file),
            regexOnly,
            astOnly,
            common,
          });
        }
      }

      // Report per-language
      console.log(`\n── Import Parity: fixtures (multi-language) ──`);
      for (const [lang, stats] of [...langStats.entries()].sort()) {
        const parity = stats.regexOnly === 0 && stats.astOnly === 0 ? "PARITY" : "DIVERGENT";
        console.log(
          `  ${lang.padEnd(12)} ${stats.files} files, ${stats.common} common, regex-only=${stats.regexOnly}, ast-only=${stats.astOnly} [${parity}]`,
        );
      }

      if (diffs.length > 0) {
        console.log(`\nDivergences in ${diffs.length} files:`);
        for (const d of diffs) {
          console.log(`\n  ${d.file} (${d.common} common)`);
          for (const imp of d.regexOnly) {
            console.log(
              `    REGEX-ONLY: ${imp.specifier} [${imp.importedNames.join(", ")}]${imp.isTypeOnly ? " (type)" : ""}${imp.isDynamic ? " (dynamic)" : ""}`,
            );
          }
          for (const imp of d.astOnly) {
            console.log(
              `    AST-ONLY:   ${imp.specifier} [${imp.importedNames.join(", ")}]${imp.isTypeOnly ? " (type)" : ""}${imp.isDynamic ? " (dynamic)" : ""}`,
            );
          }
        }
      } else {
        console.log("\nPerfect parity: no divergences found.");
      }

      expect({ langStats: Object.fromEntries(langStats), divergentFiles: diffs.length }).toBeDefined();
    });
  });

  // ── Snapshot Extraction Parity ─────────────────────────────────────────
  // We can't inline the old regex snapshot extractors (800+ lines), but we
  // CAN verify that the AST extractor produces reasonable output for every
  // fixture file and spot-check specific expectations.

  describe("Snapshot extraction: sanity checks on fixtures", () => {
    const fixtures: Array<{ file: string; lang: Language; expectCategories: string[]; expectMinEntries: number }> = [
      {
        file: "src/__tests__/golden/fixtures/ts-layered/types/index.ts",
        lang: "typescript",
        expectCategories: ["type", "interface"],
        expectMinEntries: 2,
      },
      {
        file: "src/__tests__/golden/fixtures/ts-layered/services/user-service.ts",
        lang: "typescript",
        expectCategories: ["hook"],
        expectMinEntries: 1,
      },
      {
        file: "src/__tests__/integration/fixtures/python-app/core/models.py",
        lang: "python",
        expectCategories: ["type"],
        expectMinEntries: 1,
      },
      {
        file: "src/__tests__/integration/fixtures/go-service/internal/model/user.go",
        lang: "go",
        expectCategories: ["type"],
        expectMinEntries: 1,
      },
      {
        file: "src/__tests__/integration/fixtures/rust-lib/src/models/user.rs",
        lang: "rust",
        expectCategories: ["type"],
        expectMinEntries: 1,
      },
      {
        file: "src/__tests__/integration/fixtures/java-app/src/com/example/model/User.java",
        lang: "java",
        expectCategories: ["type"],
        expectMinEntries: 1,
      },
    ];

    for (const fx of fixtures) {
      it(`extracts entries from ${path.basename(fx.file)} (${fx.lang})`, () => {
        const absPath = path.join(PROJECT_ROOT, fx.file);
        const content = readFileSync(absPath, "utf-8");
        const relPath = fx.file;

        const entries = extractSnapshotAst(content, relPath, fx.lang);

        console.log(`  ${fx.file}: ${entries.length} entries`);
        for (const e of entries) {
          const sigPreview = e.signature.split("\n")[0].slice(0, 80);
          console.log(`    [${e.category}] ${sigPreview}`);
        }

        expect(entries.length).toBeGreaterThanOrEqual(fx.expectMinEntries);
        const categories = new Set(entries.map((e) => e.category));
        for (const cat of fx.expectCategories) {
          expect(categories, `Expected category "${cat}" in ${fx.file}`).toContain(cat);
        }
      });
    }
  });

  // ── Edge Cases: known regex weaknesses ─────────────────────────────────
  // These test specific patterns where regex parsers are known to struggle.
  // If AST handles them correctly and regex doesn't, that's an improvement.
  // If both fail, we have a gap to address.

  describe("Edge cases: regex weaknesses", () => {
    it("handles import inside template literal (should be ignored)", () => {
      const code = `
const msg = \`import { Foo } from 'bar'\`;
import { Real } from './real';
`;
      const regex = regexParseJsImports(code);
      const ast = parseImportsAst(code, "typescript");

      console.log(`  Template literal import:`);
      console.log(`    Regex: ${regex.map((i) => i.specifier).join(", ")}`);
      console.log(`    AST:   ${ast.map((i) => i.specifier).join(", ")}`);

      // AST should only find './real'; regex might also find 'bar'
      const astSpecs = ast.map((i) => i.specifier);
      expect(astSpecs).toContain("./real");
      expect(astSpecs).not.toContain("bar");
    });

    it("handles multi-line import with inline comment", () => {
      const code = `
import {
  Foo, // this is Foo
  Bar, /* and Bar */
  Baz,
} from './module';
`;
      const regex = regexParseJsImports(code);
      const ast = parseImportsAst(code, "typescript");

      console.log(`  Multi-line import with comments:`);
      console.log(`    Regex names: ${regex.flatMap((i) => i.importedNames).join(", ")}`);
      console.log(`    AST names:   ${ast.flatMap((i) => i.importedNames).join(", ")}`);

      // Both should find Foo, Bar, Baz from './module'
      const astNames = ast.flatMap((i) => i.importedNames).sort();
      expect(astNames).toContain("Foo");
      expect(astNames).toContain("Bar");
      expect(astNames).toContain("Baz");
    });

    it("handles import inside comment (should be ignored)", () => {
      const code = `
// import { Fake } from './fake';
/* import { AlsoFake } from './also-fake'; */
import { Real } from './real';
`;
      const regex = regexParseJsImports(code);
      const ast = parseImportsAst(code, "typescript");

      console.log(`  Commented-out import:`);
      console.log(`    Regex: ${regex.map((i) => i.specifier).join(", ")}`);
      console.log(`    AST:   ${ast.map((i) => i.specifier).join(", ")}`);

      const astSpecs = ast.map((i) => i.specifier);
      expect(astSpecs).toContain("./real");
      expect(astSpecs).not.toContain("./fake");
      expect(astSpecs).not.toContain("./also-fake");
    });

    it("handles export { type Foo } from (individual type re-export)", () => {
      const code = `
export { type Foo, Bar } from './source';
`;
      const regex = regexParseJsImports(code);
      const ast = parseImportsAst(code, "typescript");

      console.log(`  Individual type re-export:`);
      console.log(`    Regex: ${JSON.stringify(regex)}`);
      console.log(`    AST:   ${JSON.stringify(ast)}`);

      // AST should detect this as a re-export from './source'
      const astSpecs = ast.map((i) => i.specifier);
      expect(astSpecs).toContain("./source");
    });

    it("handles Python TYPE_CHECKING with nested conditions", () => {
      const code = `
from typing import TYPE_CHECKING
import os

if TYPE_CHECKING:
    from models import User
    from services import AuthService

def main():
    pass
`;
      const regex = regexParsePythonImports(code);
      const ast = parseImportsAst(code, "python");

      console.log(`  Python TYPE_CHECKING:`);
      console.log(`    Regex: ${JSON.stringify(regex.map((i) => ({ s: i.specifier, type: i.isTypeOnly })))}`);
      console.log(`    AST:   ${JSON.stringify(ast.map((i) => ({ s: i.specifier, type: i.isTypeOnly })))}`);

      // Both should find 'models' and 'services' as type-only
      const astTypeOnly = ast.filter((i) => i.isTypeOnly);
      expect(astTypeOnly.length).toBeGreaterThanOrEqual(2);
    });

    it("handles Rust nested brace use declarations", () => {
      const code = `
use crate::models::{User, Product};
use crate::handlers::{user_handler, product_handler};
`;
      const regex = regexParseRustImports(code);
      const ast = parseImportsAst(code, "rust");

      console.log(`  Rust nested braces:`);
      console.log(`    Regex: ${JSON.stringify(regex.map((i) => ({ s: i.specifier, n: i.importedNames })))}`);
      console.log(`    AST:   ${JSON.stringify(ast.map((i) => ({ s: i.specifier, n: i.importedNames })))}`);

      // Both should find imported names
      const astNames = ast.flatMap((i) => i.importedNames);
      expect(astNames).toContain("User");
      expect(astNames).toContain("Product");
    });
  });
});
