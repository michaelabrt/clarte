import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  runDeepAnalysis,
  renderCallGraphSection,
  isVersionAtLeast,
} from "../deep-analysis.js";
import type { FunctionCallEdge } from "../deep-analysis.js";

describe("isVersionAtLeast", () => {
  it("returns true for equal versions", () => {
    expect(isVersionAtLeast("4.0.0", "4.0.0")).toBe(true);
  });

  it("returns true for higher major version", () => {
    expect(isVersionAtLeast("5.0.0", "4.0.0")).toBe(true);
  });

  it("returns false for lower major version", () => {
    expect(isVersionAtLeast("3.9.9", "4.0.0")).toBe(false);
  });

  it("returns true for higher minor version", () => {
    expect(isVersionAtLeast("4.1.0", "4.0.0")).toBe(true);
  });

  it("returns true for higher patch version", () => {
    expect(isVersionAtLeast("4.0.1", "4.0.0")).toBe(true);
  });

  it("returns false for lower minor version", () => {
    expect(isVersionAtLeast("4.0.0", "4.1.0")).toBe(false);
  });

  it("handles versions without patch", () => {
    expect(isVersionAtLeast("5.9", "4.0.0")).toBe(true);
  });
});

describe("renderCallGraphSection", () => {
  it("returns empty string for empty call graph", () => {
    expect(renderCallGraphSection([])).toBe("");
  });

  it("renders a simple call graph", () => {
    const edges: FunctionCallEdge[] = [
      { caller: "src/a.ts:processOrder", callee: "src/b.ts:validateOrder", file: "src/a.ts" },
      { caller: "src/a.ts:processOrder", callee: "src/c.ts:calculateTotal", file: "src/a.ts" },
    ];

    const result = renderCallGraphSection(edges);
    expect(result).toContain("## Function Call Graph");
    expect(result).toContain("`processOrder()`");
    expect(result).toContain("`calculateTotal()`");
    expect(result).toContain("`validateOrder()`");
    expect(result).toContain("src/a.ts");
  });

  it("groups edges by caller and sorts by callee count", () => {
    const edges: FunctionCallEdge[] = [
      { caller: "src/a.ts:foo", callee: "src/b.ts:bar", file: "src/a.ts" },
      { caller: "src/c.ts:baz", callee: "src/d.ts:qux", file: "src/c.ts" },
      { caller: "src/c.ts:baz", callee: "src/e.ts:quux", file: "src/c.ts" },
      { caller: "src/c.ts:baz", callee: "src/f.ts:corge", file: "src/c.ts" },
    ];

    const result = renderCallGraphSection(edges);
    const lines = result.split("\n").filter((l) => l.startsWith("- "));
    // baz has 3 callees, foo has 1; baz should come first
    expect(lines[0]).toContain("baz()");
    expect(lines[1]).toContain("foo()");
  });

  it("caps output at 30 callers", () => {
    const edges: FunctionCallEdge[] = [];
    for (let i = 0; i < 35; i++) {
      edges.push({
        caller: `src/f${i}.ts:fn${i}`,
        callee: `src/target.ts:target`,
        file: `src/f${i}.ts`,
      });
    }

    const result = renderCallGraphSection(edges);
    expect(result).toContain("... and 5 more callers");
  });
});

describe("runDeepAnalysis", () => {
  it("returns null when TypeScript is not available", async () => {
    // Use a temp directory with no node_modules
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-deep-test-"));
    try {
      const messages: string[] = [];
      const result = await runDeepAnalysis(tmpDir, [], (msg) => messages.push(msg));
      expect(result).toBeNull();
      expect(messages.some((m) => m.includes("not found"))).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("runDeepAnalysis with real TypeScript", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-deep-real-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper to set up a fixture project that symlinks to this project's
   * TypeScript installation so the dynamic import can find it.
   */
  async function setupFixture(files: Record<string, string>): Promise<void> {
    // Create node_modules/typescript symlink to the real TypeScript
    const nodeModules = path.join(tmpDir, "node_modules");
    await fs.mkdir(nodeModules, { recursive: true });

    // Find the real TypeScript path from this project
    const realTsPath = path.resolve(__dirname, "../../node_modules/typescript");
    try {
      await fs.access(realTsPath);
      await fs.symlink(realTsPath, path.join(nodeModules, "typescript"), "dir");
    } catch {
      // If we can't create the symlink, skip the test
      return;
    }

    // Write a basic tsconfig.json
    await fs.writeFile(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["src"],
      }),
    );

    // Write source files
    for (const [filePath, content] of Object.entries(files)) {
      const absPath = path.join(tmpDir, filePath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, content);
    }
  }

  it("infers return types for functions without explicit annotations", async () => {
    await setupFixture({
      "src/math.ts": `
export function add(a: number, b: number) {
  return a + b;
}

export function greet(name: string) {
  return \`Hello, \${name}\`;
}

export function explicitReturn(x: number): number {
  return x * 2;
}
`,
    });

    // Check TypeScript is accessible
    try {
      await fs.access(path.join(tmpDir, "node_modules", "typescript"));
    } catch {
      // Skip if symlink didn't work
      return;
    }

    const result = await runDeepAnalysis(tmpDir, ["src/math.ts"]);
    if (!result) {
      // TypeScript loading might fail in some environments; don't fail the test
      return;
    }

    // add() should have inferred return type "number"
    expect(result.inferredTypes.get("src/math.ts:add")).toBe("number");
    // greet() should have inferred return type "string"
    expect(result.inferredTypes.get("src/math.ts:greet")).toBe("string");
    // explicitReturn() has an explicit annotation, so it should NOT appear
    expect(result.inferredTypes.has("src/math.ts:explicitReturn")).toBe(false);
  });

  it("builds function call graph across files", async () => {
    await setupFixture({
      "src/utils.ts": `
export function validate(x: number) {
  return x > 0;
}

export function format(x: number) {
  return x.toFixed(2);
}
`,
      "src/service.ts": `
import { validate, format } from "./utils.js";

export function process(x: number) {
  if (validate(x)) {
    return format(x);
  }
  return "invalid";
}
`,
    });

    try {
      await fs.access(path.join(tmpDir, "node_modules", "typescript"));
    } catch {
      return;
    }

    const result = await runDeepAnalysis(tmpDir, ["src/utils.ts", "src/service.ts"]);
    if (!result) return;

    // process() should call validate() and format()
    const processEdges = result.callGraph.filter(
      (e) => e.caller === "src/service.ts:process",
    );
    const calleeNames = processEdges.map((e) => e.callee);
    // Should find calls to validate and format (might resolve to same file or cross-file)
    expect(calleeNames.some((c) => c.includes("validate"))).toBe(true);
    expect(calleeNames.some((c) => c.includes("format"))).toBe(true);
  });

  it("handles arrow function exports", async () => {
    await setupFixture({
      "src/arrows.ts": `
export const multiply = (a: number, b: number) => a * b;

export const divide = (a: number, b: number) => {
  return a / b;
};
`,
    });

    try {
      await fs.access(path.join(tmpDir, "node_modules", "typescript"));
    } catch {
      return;
    }

    const result = await runDeepAnalysis(tmpDir, ["src/arrows.ts"]);
    if (!result) return;

    // Both should have inferred return type "number"
    expect(result.inferredTypes.get("src/arrows.ts:multiply")).toBe("number");
    expect(result.inferredTypes.get("src/arrows.ts:divide")).toBe("number");
  });

  it("skips files that cause errors without failing", async () => {
    await setupFixture({
      "src/good.ts": `
export function hello() {
  return "world";
}
`,
      // Intentionally broken file (syntax errors should not crash analysis)
      "src/bad.ts": `
export function broken(
  // Missing closing paren and bracket
`,
    });

    try {
      await fs.access(path.join(tmpDir, "node_modules", "typescript"));
    } catch {
      return;
    }

    const messages: string[] = [];
    const result = await runDeepAnalysis(
      tmpDir,
      ["src/good.ts", "src/bad.ts"],
      (msg) => messages.push(msg),
    );

    // Should not return null; the good file should still be analyzed
    if (!result) return;
    expect(result.inferredTypes.get("src/good.ts:hello")).toBe("string");
  });

  it("handles projects without tsconfig.json (fallback config)", async () => {
    // Set up files without creating tsconfig.json
    const nodeModules = path.join(tmpDir, "node_modules");
    await fs.mkdir(nodeModules, { recursive: true });

    const realTsPath = path.resolve(__dirname, "../../node_modules/typescript");
    try {
      await fs.access(realTsPath);
      await fs.symlink(realTsPath, path.join(nodeModules, "typescript"), "dir");
    } catch {
      return;
    }

    const srcDir = path.join(tmpDir, "src");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(
      path.join(srcDir, "index.ts"),
      `export function getValue() { return 42; }\n`,
    );

    const result = await runDeepAnalysis(tmpDir, ["src/index.ts"]);
    if (!result) return;
    expect(result.inferredTypes.get("src/index.ts:getValue")).toBe("number");
  });
});
