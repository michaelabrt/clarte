import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { analyzeMonorepoGraph } from "../monorepo-analysis.js";
import type { ImportEdge, ImportGraph, MonorepoInfo } from "../types.js";

/** Helper to create a minimal ImportGraph from edges */
function makeGraph(edges: ImportEdge[]): ImportGraph {
  const inDegree = new Map<string, number>();
  const centrality = new Map<string, number>();
  const externalImportCounts = new Map<string, number>();
  const authority = new Map<string, number>();
  const hubScores = new Map<string, number>();

  for (const edge of edges) {
    if (!edge.isExternal) {
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }
  }

  return { edges, inDegree, centrality, externalImportCounts, authority, hubScores };
}

/** Helper to create an internal ImportEdge */
function edge(from: string, to: string): ImportEdge {
  return {
    from,
    to,
    isExternal: false,
    specifier: `./${to}`,
    importedNames: [],
  };
}

describe("analyzeMonorepoGraph", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-mono-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const monorepo: MonorepoInfo = {
    type: "pnpm-workspaces",
    packages: [
      { name: "@app/web", path: "packages/web", dependencies: [], frameworks: [] },
      { name: "@app/api", path: "packages/api", dependencies: [], frameworks: [] },
      { name: "@app/shared", path: "packages/shared", dependencies: [], frameworks: [] },
    ],
  };

  async function setupPackageJsons() {
    // Create package.json files for each package (no main/exports fields)
    for (const pkg of monorepo.packages) {
      const pkgDir = path.join(tmpDir, pkg.path);
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: pkg.name }),
      );
    }
  }

  it("detects cross-package edges correctly", async () => {
    await setupPackageJsons();

    const graph = makeGraph([
      edge("packages/web/src/app.ts", "packages/shared/src/index.ts"),
      edge("packages/api/src/handler.ts", "packages/shared/src/index.ts"),
    ]);

    const result = await analyzeMonorepoGraph(tmpDir, graph, monorepo);

    expect(result.crossPackageEdges).toHaveLength(2);
    expect(result.crossPackageEdges[0].fromPackage).toBe("@app/web");
    expect(result.crossPackageEdges[0].toPackage).toBe("@app/shared");
    expect(result.crossPackageEdges[1].fromPackage).toBe("@app/api");
    expect(result.crossPackageEdges[1].toPackage).toBe("@app/shared");
  });

  it("does not flag same-package edges", async () => {
    await setupPackageJsons();

    const graph = makeGraph([
      edge("packages/web/src/app.ts", "packages/web/src/utils.ts"),
      edge("packages/api/src/handler.ts", "packages/api/src/db.ts"),
    ]);

    const result = await analyzeMonorepoGraph(tmpDir, graph, monorepo);

    expect(result.crossPackageEdges).toHaveLength(0);
    expect(result.encapsulationViolations).toHaveLength(0);
  });

  it("detects encapsulation violations (importing internal files)", async () => {
    await setupPackageJsons();

    const graph = makeGraph([
      // This imports an internal file, not the package index
      edge("packages/api/src/handler.ts", "packages/shared/src/internal/db.ts"),
    ]);

    const result = await analyzeMonorepoGraph(tmpDir, graph, monorepo);

    expect(result.crossPackageEdges).toHaveLength(1);
    expect(result.encapsulationViolations).toHaveLength(1);
    expect(result.encapsulationViolations[0].from).toBe("packages/api/src/handler.ts");
    expect(result.encapsulationViolations[0].to).toBe("packages/shared/src/internal/db.ts");
    expect(result.encapsulationViolations[0].isEncapsulationViolation).toBe(true);
  });

  it("does not flag imports of a package's index file as violations", async () => {
    await setupPackageJsons();

    const graph = makeGraph([
      // Import via src/index.ts (standard entry point)
      edge("packages/web/src/app.ts", "packages/shared/src/index.ts"),
    ]);

    const result = await analyzeMonorepoGraph(tmpDir, graph, monorepo);

    expect(result.crossPackageEdges).toHaveLength(1);
    expect(result.encapsulationViolations).toHaveLength(0);
    expect(result.crossPackageEdges[0].isEncapsulationViolation).toBe(false);
  });

  it("respects package.json main field for entry points", async () => {
    // Create package.json with a main field pointing to a non-standard entry
    for (const pkg of monorepo.packages) {
      const pkgDir = path.join(tmpDir, pkg.path);
      await fs.mkdir(pkgDir, { recursive: true });
    }
    await fs.writeFile(
      path.join(tmpDir, "packages/shared/package.json"),
      JSON.stringify({ name: "@app/shared", main: "./dist/main.js" }),
    );
    await fs.writeFile(
      path.join(tmpDir, "packages/web/package.json"),
      JSON.stringify({ name: "@app/web" }),
    );
    await fs.writeFile(
      path.join(tmpDir, "packages/api/package.json"),
      JSON.stringify({ name: "@app/api" }),
    );

    const graph = makeGraph([
      // Import via main entry point
      edge("packages/web/src/app.ts", "packages/shared/dist/main.js"),
      // Import via internal file
      edge("packages/api/src/handler.ts", "packages/shared/src/internal/db.ts"),
    ]);

    const result = await analyzeMonorepoGraph(tmpDir, graph, monorepo);

    expect(result.crossPackageEdges).toHaveLength(2);
    // main entry point import should NOT be a violation
    const mainImport = result.crossPackageEdges.find(
      (e) => e.to === "packages/shared/dist/main.js",
    );
    expect(mainImport?.isEncapsulationViolation).toBe(false);
    // internal import should be a violation
    const internalImport = result.crossPackageEdges.find(
      (e) => e.to === "packages/shared/src/internal/db.ts",
    );
    expect(internalImport?.isEncapsulationViolation).toBe(true);
  });

  it("builds package dependencies map correctly", async () => {
    await setupPackageJsons();

    const graph = makeGraph([
      edge("packages/web/src/app.ts", "packages/shared/src/index.ts"),
      edge("packages/web/src/page.ts", "packages/shared/src/index.ts"),
      edge("packages/api/src/handler.ts", "packages/shared/src/index.ts"),
      edge("packages/web/src/app.ts", "packages/api/src/index.ts"),
    ]);

    const result = await analyzeMonorepoGraph(tmpDir, graph, monorepo);

    // @app/web depends on @app/shared and @app/api
    const webDeps = result.packageDependencies.get("@app/web");
    expect(webDeps).toBeDefined();
    expect([...webDeps!].sort()).toEqual(["@app/api", "@app/shared"]);

    // @app/api depends on @app/shared
    const apiDeps = result.packageDependencies.get("@app/api");
    expect(apiDeps).toBeDefined();
    expect([...apiDeps!]).toEqual(["@app/shared"]);

    // @app/shared depends on nothing
    const sharedDeps = result.packageDependencies.get("@app/shared");
    expect(sharedDeps).toBeDefined();
    expect([...sharedDeps!]).toEqual([]);
  });

  it("handles empty monorepo (no cross-package edges)", async () => {
    await setupPackageJsons();

    const graph = makeGraph([
      // Only intra-package edges
      edge("packages/web/src/app.ts", "packages/web/src/utils.ts"),
    ]);

    const result = await analyzeMonorepoGraph(tmpDir, graph, monorepo);

    expect(result.crossPackageEdges).toHaveLength(0);
    expect(result.encapsulationViolations).toHaveLength(0);
    expect([...result.packageDependencies.values()].every((s) => s.size === 0)).toBe(true);
  });

  it("ignores external edges", async () => {
    await setupPackageJsons();

    const graph = makeGraph([
      {
        from: "packages/web/src/app.ts",
        to: "react",
        isExternal: true,
        specifier: "react",
        importedNames: ["useState"],
      },
    ]);

    const result = await analyzeMonorepoGraph(tmpDir, graph, monorepo);

    expect(result.crossPackageEdges).toHaveLength(0);
  });

  it("ignores files not belonging to any known package", async () => {
    await setupPackageJsons();

    const graph = makeGraph([
      // Root-level file importing a package file
      edge("scripts/build.ts", "packages/shared/src/index.ts"),
    ]);

    const result = await analyzeMonorepoGraph(tmpDir, graph, monorepo);

    // scripts/build.ts does not belong to any package, so no cross-package edge
    expect(result.crossPackageEdges).toHaveLength(0);
  });
});
