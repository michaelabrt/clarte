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
