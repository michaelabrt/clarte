import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import { buildImportGraph } from "../graph.js";

/** Create a temporary project directory with the given file tree. */
async function makeProject(files: Record<string, string>): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-alias-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(tmpDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
  }
  return tmpDir;
}

async function cleanup(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}

describe("buildImportGraph with tsconfig path aliases", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("resolves @/ path alias to src/", async () => {
    tmpDir = await makeProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["src/*"] },
        },
      }),
      "src/utils.ts": "export const helper = 1;",
      "src/index.ts": "import { helper } from '@/utils';",
    });

    const graph = await buildImportGraph(tmpDir, "typescript");

    const internalEdges = graph.edges.filter((e) => !e.isExternal);
    expect(internalEdges).toHaveLength(1);
    expect(internalEdges[0].from).toBe("src/index.ts");
    expect(internalEdges[0].to).toBe("src/utils.ts");
    expect(internalEdges[0].importedNames).toEqual(["helper"]);
  });

  it("follows extends chain to find path aliases", async () => {
    tmpDir = await makeProject({
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@lib/*": ["lib/*"] },
        },
      }),
      "tsconfig.json": JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: {
          strict: true,
        },
      }),
      "lib/math.ts": "export function add(a: number, b: number) { return a + b; }",
      "src/app.ts": "import { add } from '@lib/math';",
    });

    const graph = await buildImportGraph(tmpDir, "typescript");

    const internalEdges = graph.edges.filter((e) => !e.isExternal);
    expect(internalEdges).toHaveLength(1);
    expect(internalEdges[0].to).toBe("lib/math.ts");
  });

  it("child tsconfig paths override parent paths", async () => {
    tmpDir = await makeProject({
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["old-src/*"] },
        },
      }),
      "tsconfig.json": JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: {
          paths: { "@/*": ["src/*"] },
        },
      }),
      "src/utils.ts": "export const x = 1;",
      "src/index.ts": "import { x } from '@/utils';",
    });

    const graph = await buildImportGraph(tmpDir, "typescript");

    const internalEdges = graph.edges.filter((e) => !e.isExternal);
    expect(internalEdges).toHaveLength(1);
    expect(internalEdges[0].to).toBe("src/utils.ts");
  });

  it("treats unresolvable alias imports as external", async () => {
    tmpDir = await makeProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          paths: { "@/*": ["src/*"] },
        },
      }),
      "src/index.ts": "import { x } from '@/nonexistent';",
    });

    const graph = await buildImportGraph(tmpDir, "typescript");

    // Should fall through to external since the file doesn't exist
    const externalEdges = graph.edges.filter((e) => e.isExternal);
    expect(externalEdges).toHaveLength(1);
  });
});

describe("buildImportGraph barrel file resolution", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("routes named imports through barrel to correct source files", async () => {
    tmpDir = await makeProject({
      "src/utils/helpers.ts": "export function helperA() {} export function helperB() {}",
      "src/utils/format.ts": "export function formatDate() {}",
      "src/utils/index.ts": [
        "export { helperA, helperB } from './helpers';",
        "export { formatDate } from './format';",
      ].join("\n"),
      "src/app.ts": "import { helperA, formatDate } from './utils';",
    });

    const graph = await buildImportGraph(tmpDir, "typescript");
    const internal = graph.edges.filter((e) => !e.isExternal);

    // helperA should route to helpers.ts, formatDate to format.ts
    const toHelpers = internal.find((e) => e.to === "src/utils/helpers.ts");
    const toFormat = internal.find((e) => e.to === "src/utils/format.ts");

    expect(toHelpers).toBeDefined();
    expect(toHelpers!.importedNames).toEqual(["helperA"]);

    expect(toFormat).toBeDefined();
    expect(toFormat!.importedNames).toEqual(["formatDate"]);

    // No direct edge to the barrel index.ts itself (since all names were resolved)
    const toBarrel = internal.find((e) => e.to === "src/utils/index.ts" && e.from === "src/app.ts");
    expect(toBarrel).toBeUndefined();
  });

  it("falls back to star export sources for unresolved names", async () => {
    tmpDir = await makeProject({
      "src/lib/types.ts": "export interface Foo {} export interface Bar {}",
      "src/lib/index.ts": "export * from './types';",
      "src/app.ts": "import { Foo } from './lib';",
    });

    const graph = await buildImportGraph(tmpDir, "typescript");
    const internal = graph.edges.filter((e) => !e.isExternal);

    // Foo can't be resolved by named exports, should fall back to star source
    const toTypes = internal.find((e) => e.to === "src/lib/types.ts");
    expect(toTypes).toBeDefined();
    expect(toTypes!.importedNames).toEqual(["Foo"]);
  });

  it("handles mixed named and star exports in a barrel", async () => {
    tmpDir = await makeProject({
      "src/mod/alpha.ts": "export const a = 1;",
      "src/mod/beta.ts": "export const b = 2; export const c = 3;",
      "src/mod/index.ts": ["export { a } from './alpha';", "export * from './beta';"].join("\n"),
      "src/consumer.ts": "import { a, b } from './mod';",
    });

    const graph = await buildImportGraph(tmpDir, "typescript");
    const internal = graph.edges.filter((e) => !e.isExternal);

    // 'a' should route to alpha.ts via named export
    const toAlpha = internal.find((e) => e.to === "src/mod/alpha.ts");
    expect(toAlpha).toBeDefined();
    expect(toAlpha!.importedNames).toEqual(["a"]);

    // 'b' should route to beta.ts via star export fallback
    const toBeta = internal.find((e) => e.to === "src/mod/beta.ts");
    expect(toBeta).toBeDefined();
    expect(toBeta!.importedNames).toEqual(["b"]);
  });

  it("keeps edge to barrel for side-effect imports (no names)", async () => {
    tmpDir = await makeProject({
      "src/setup/init.ts": "export const x = 1;",
      "src/setup/index.ts": "export { x } from './init';",
      "src/app.ts": "import './setup';",
    });

    const graph = await buildImportGraph(tmpDir, "typescript");
    const internal = graph.edges.filter((e) => !e.isExternal);

    // Side-effect import should keep edge to barrel itself
    const toBarrel = internal.find((e) => e.to === "src/setup/index.ts");
    expect(toBarrel).toBeDefined();
    expect(toBarrel!.importedNames).toEqual([]);
  });

  it("tracks directInDegree vs inDegree for barrel-routed imports", async () => {
    tmpDir = await makeProject({
      "src/utils/helpers.ts": "export function helperA() {}",
      "src/utils/format.ts": "export function formatDate() {}",
      "src/utils/index.ts": ["export { helperA } from './helpers';", "export { formatDate } from './format';"].join(
        "\n",
      ),
      // Two consumers go through the barrel
      "src/app.ts": "import { helperA } from './utils';",
      "src/page.ts": "import { helperA } from './utils';",
      // One consumer imports directly
      "src/direct.ts": "import { helperA } from './utils/helpers';",
    });

    const graph = await buildImportGraph(tmpDir, "typescript");

    // helpers.ts: 4 total importers (barrel's own re-export + 2 barrel-routed + 1 direct)
    expect(graph.inDegree.get("src/utils/helpers.ts")).toBe(4);
    // helpers.ts: 3 direct importers (direct.ts + 2 barrel-routed from app.ts, page.ts;
    // barrel's own re-export from index.ts is excluded)
    expect(graph.directInDegree?.get("src/utils/helpers.ts")).toBe(3);

    // Barrel-routed edges should be flagged (app.ts + page.ts)
    const barrelEdges = graph.edges.filter((e) => e.to === "src/utils/helpers.ts" && e.isBarrelRouted);
    expect(barrelEdges).toHaveLength(2);

    // Direct edges: barrel's own re-export (index.ts) + direct.ts
    const directEdges = graph.edges.filter((e) => e.to === "src/utils/helpers.ts" && !e.isBarrelRouted);
    expect(directEdges).toHaveLength(2);
  });
});
