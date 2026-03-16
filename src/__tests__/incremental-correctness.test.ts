import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildGraphWithCache } from "../core/graph/cache.js";
import type { ImportEdge, ImportGraph } from "../core/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────

async function makeProject(files: Record<string, string>): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-incr-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(tmpDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
  }
  return tmpDir;
}

async function deleteCache(rootDir: string): Promise<void> {
  const dbPath = path.join(rootDir, ".clarte", "graph.db");
  try {
    await fs.unlink(dbPath);
    await fs.unlink(dbPath + "-wal").catch(() => null);
    await fs.unlink(dbPath + "-shm").catch(() => null);
  } catch {
    // no cache to delete
  }
}

interface NormalizedEdge {
  from: string;
  to: string;
  importedNames: string[];
  isBarrelRouted: boolean;
  isTypeOnly: boolean;
  isDynamic: boolean;
  isExternal: boolean;
}

function normalizeEdge(edge: ImportEdge): NormalizedEdge {
  return {
    from: edge.from,
    to: edge.to,
    importedNames: [...edge.importedNames].sort(),
    isBarrelRouted: edge.isBarrelRouted ?? false,
    isTypeOnly: edge.isTypeOnly ?? false,
    isDynamic: edge.isDynamic ?? false,
    isExternal: edge.isExternal,
  };
}

function sortedEdges(edges: ImportEdge[]): NormalizedEdge[] {
  return edges.map(normalizeEdge).sort((a, b) => {
    const k = `${a.from}\0${a.to}\0${a.importedNames.join(",")}`;
    const l = `${b.from}\0${b.to}\0${b.importedNames.join(",")}`;
    return k < l ? -1 : k > l ? 1 : 0;
  });
}

function sortedMap(m: Map<string, number>): [string, number][] {
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function assertGraphsEqual(actual: ImportGraph, expected: ImportGraph): void {
  // Edges (structural, ignoring specifier)
  expect(sortedEdges(actual.edges)).toEqual(sortedEdges(expected.edges));

  // Degree maps (exact)
  expect(sortedMap(actual.inDegree)).toEqual(sortedMap(expected.inDegree));
  if (actual.directInDegree && expected.directInDegree) {
    expect(sortedMap(actual.directInDegree)).toEqual(sortedMap(expected.directInDegree));
  }
  expect(sortedMap(actual.externalImportCounts)).toEqual(sortedMap(expected.externalImportCounts));

  // Barrel files (exact)
  expect([...(actual.barrelFiles ?? [])].sort()).toEqual([...(expected.barrelFiles ?? [])].sort());

  // HITS scores (approximate — float noise from iteration order)
  const actualAuth = sortedMap(actual.authority);
  const expectedAuth = sortedMap(expected.authority);
  expect(actualAuth.length).toBe(expectedAuth.length);
  for (let i = 0; i < actualAuth.length; i++) {
    expect(actualAuth[i][0]).toBe(expectedAuth[i][0]);
    expect(actualAuth[i][1]).toBeCloseTo(expectedAuth[i][1], 8);
  }

  const actualHub = sortedMap(actual.hubScores);
  const expectedHub = sortedMap(expected.hubScores);
  expect(actualHub.length).toBe(expectedHub.length);
  for (let i = 0; i < actualHub.length; i++) {
    expect(actualHub[i][0]).toBe(expectedHub[i][0]);
    expect(actualHub[i][1]).toBeCloseTo(expectedHub[i][1], 8);
  }

  // Skip betweennessScores — sampled, non-deterministic
}

// ── Base Project ─────────────────────────────────────────────────────────

function baseProject(): Record<string, string> {
  return {
    "src/lib/alpha.ts": 'export const alpha = 1;\nexport function greetAlpha() { return "hi"; }\n',
    "src/lib/beta.ts": "export const beta = 2;\n",
    "src/lib/gamma.ts": 'export const gamma = 3;\nexport function gammaFn() { return "g"; }\n',
    "src/lib/index.ts": [
      'export { alpha, greetAlpha } from "./alpha";',
      'export { beta } from "./beta";',
      'export * from "./gamma";',
      "",
    ].join("\n"),
    "src/utils.ts": "export function helper() { return 42; }\nexport const VERSION = 1;\n",
    "src/app.ts":
      'import { alpha, beta } from "./lib";\nimport { helper } from "./utils";\nconsole.log(alpha, beta, helper());\n',
    "src/dashboard.ts":
      'import { greetAlpha } from "./lib";\nimport { VERSION } from "./utils";\nconsole.log(greetAlpha(), VERSION);\n',
    "src/types.ts": "export interface User { name: string; }\nexport type Id = number;\n",
    "src/config.ts": "export const CONFIG = { debug: false };\n",
    "src/validate.ts": "export function validate(x: unknown) { return !!x; }\n",
    "src/f0.ts": 'import { helper } from "./utils";\nexport const f0 = helper();\n',
    "src/f1.ts": 'import { helper } from "./utils";\nexport const f1 = helper();\n',
    "src/f2.ts": 'import { helper } from "./utils";\nexport const f2 = helper();\n',
    "src/f3.ts": 'import { helper } from "./utils";\nexport const f3 = helper();\n',
    "src/f4.ts": 'import { helper } from "./utils";\nexport const f4 = helper();\n',
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seedCache(): Promise<void> {
  await buildGraphWithCache(tmpDir, "typescript");
}

async function incrementalRebuild(): Promise<ImportGraph> {
  return buildGraphWithCache(tmpDir, "typescript");
}

async function fullRebuild(): Promise<ImportGraph> {
  await deleteCache(tmpDir);
  return buildGraphWithCache(tmpDir, "typescript");
}

describe("incremental correctness", () => {
  it("1: non-barrel file modified", async () => {
    tmpDir = await makeProject(baseProject());
    await seedCache();

    // Mutate: dashboard changes its imports
    await fs.writeFile(
      path.join(tmpDir, "src/dashboard.ts"),
      'import { alpha } from "./lib";\nimport { helper } from "./utils";\nconsole.log(alpha, helper());\n',
    );

    const incr = await incrementalRebuild();
    const full = await fullRebuild();
    assertGraphsEqual(incr, full);
  });

  it("2: source behind barrel modified", async () => {
    tmpDir = await makeProject(baseProject());
    await seedCache();

    // Add an export to alpha.ts (source behind barrel)
    await fs.writeFile(
      path.join(tmpDir, "src/lib/alpha.ts"),
      'export const alpha = 1;\nexport function greetAlpha() { return "hi"; }\nexport const alphaExtra = 99;\n',
    );

    const incr = await incrementalRebuild();
    const full = await fullRebuild();
    assertGraphsEqual(incr, full);
  });

  it("3: wildcard re-export — new consumer import", async () => {
    tmpDir = await makeProject(baseProject());
    await seedCache();

    // Add new export to gamma (star-exported through barrel)
    await fs.writeFile(
      path.join(tmpDir, "src/lib/gamma.ts"),
      'export const gamma = 3;\nexport function gammaFn() { return "g"; }\nexport const gammaNew = 42;\n',
    );

    const incr = await incrementalRebuild();
    const full = await fullRebuild();
    assertGraphsEqual(incr, full);
  });

  it("4: new file added", async () => {
    tmpDir = await makeProject(baseProject());
    await seedCache();

    // Add a new file importing utils
    await fs.writeFile(
      path.join(tmpDir, "src/newfile.ts"),
      'import { helper } from "./utils";\nexport const nf = helper();\n',
    );

    const incr = await incrementalRebuild();
    const full = await fullRebuild();
    assertGraphsEqual(incr, full);
  });

  it("5: leaf file deleted", async () => {
    tmpDir = await makeProject(baseProject());
    await seedCache();

    await fs.unlink(path.join(tmpDir, "src/validate.ts"));

    const incr = await incrementalRebuild();
    const full = await fullRebuild();
    assertGraphsEqual(incr, full);
  });

  it("6: edge deletion — import removed", async () => {
    tmpDir = await makeProject(baseProject());
    await seedCache();

    // Remove the utils import from app.ts
    await fs.writeFile(
      path.join(tmpDir, "src/app.ts"),
      'import { alpha, beta } from "./lib";\nconsole.log(alpha, beta);\n',
    );

    const incr = await incrementalRebuild();
    const full = await fullRebuild();
    assertGraphsEqual(incr, full);
  });

  it("7: multiple files changed", async () => {
    tmpDir = await makeProject(baseProject());
    await seedCache();

    // Modify two leaf files
    await fs.writeFile(
      path.join(tmpDir, "src/f0.ts"),
      'import { VERSION } from "./utils";\nexport const f0 = VERSION;\n',
    );
    await fs.writeFile(
      path.join(tmpDir, "src/f1.ts"),
      'import { VERSION } from "./utils";\nexport const f1 = VERSION;\n',
    );

    const incr = await incrementalRebuild();
    const full = await fullRebuild();
    assertGraphsEqual(incr, full);
  });

  it("8: non-barrel becomes barrel — forces full rebuild", async () => {
    tmpDir = await makeProject(baseProject());
    await seedCache();

    // Convert types.ts into a barrel file
    await fs.writeFile(path.join(tmpDir, "src/types-user.ts"), "export interface User { name: string; }\n");
    await fs.writeFile(path.join(tmpDir, "src/types-id.ts"), "export type Id = number;\n");
    await fs.writeFile(
      path.join(tmpDir, "src/types.ts"),
      'export { User } from "./types-user";\nexport { Id } from "./types-id";\n',
    );

    const incr = await incrementalRebuild();
    const full = await fullRebuild();
    assertGraphsEqual(incr, full);
  });

  it("9: barrel removed — forces full rebuild", async () => {
    tmpDir = await makeProject(baseProject());
    await seedCache();

    // Replace barrel index.ts with plain module
    await fs.writeFile(path.join(tmpDir, "src/lib/index.ts"), "export const libVersion = 1;\n");

    const incr = await incrementalRebuild();
    const full = await fullRebuild();
    assertGraphsEqual(incr, full);
  });

  it("10: circular barrels — no hang, output matches", async () => {
    const files = baseProject();
    // Add two small barrels that re-export from each other
    files["src/circular-a.ts"] = 'export { cbVal } from "./circular-b";\nexport const caVal = 1;\n';
    files["src/circular-b.ts"] = 'export { caVal } from "./circular-a";\nexport const cbVal = 2;\n';
    // Consumer
    files["src/circ-consumer.ts"] = 'import { caVal } from "./circular-a";\nconsole.log(caVal);\n';

    tmpDir = await makeProject(files);
    await seedCache();

    // Modify consumer
    await fs.writeFile(
      path.join(tmpDir, "src/circ-consumer.ts"),
      'import { cbVal } from "./circular-b";\nconsole.log(cbVal);\n',
    );

    const incr = await incrementalRebuild();
    const full = await fullRebuild();
    assertGraphsEqual(incr, full);
  });

  it("11: no files changed — cached graph is structurally identical to fresh full rebuild", async () => {
    tmpDir = await makeProject(baseProject());
    await seedCache();

    // No mutations — exercises the totalChanged === 0 branch
    const incr = await incrementalRebuild();
    const full = await fullRebuild();
    assertGraphsEqual(incr, full);
  });

  it("12: deleted cache (simulates stale/corrupt) — falls back to full rebuild, output matches", async () => {
    tmpDir = await makeProject(baseProject());
    await seedCache();

    // Delete the graph.db to force a full rebuild (equivalent to stale/corrupt cache)
    await deleteCache(tmpDir);

    const incr = await incrementalRebuild();
    const full = await fullRebuild();
    assertGraphsEqual(incr, full);
  });

  it("13: fresh project (no cache) — full rebuild, output matches", async () => {
    tmpDir = await makeProject(baseProject());
    // No seedCache - start fresh

    const incr = await incrementalRebuild();
    const full = await fullRebuild();
    assertGraphsEqual(incr, full);
  });

  it("14: >= 10% files changed — falls back to full rebuild, output matches", async () => {
    // Use a small project so changing 2 out of 10 files = 20%, crossing the 10% threshold
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      files[`src/m${i}.ts`] = `export const m${i} = ${i};\n`;
    }
    // One central file imported by several others — gives the graph real edges
    files["src/hub.ts"] = `import { m0 } from "./m0";\nimport { m1 } from "./m1";\nexport const hub = m0 + m1;\n`;

    tmpDir = await makeProject(files);
    await seedCache();

    // Modify 2 files (20% > 10% threshold) — should force full rebuild
    await fs.writeFile(path.join(tmpDir, "src/m0.ts"), "export const m0 = 100;\n");
    await fs.writeFile(path.join(tmpDir, "src/m1.ts"), "export const m1 = 200;\n");

    const incr = await incrementalRebuild();
    const full = await fullRebuild();
    assertGraphsEqual(incr, full);
  });

  it("15: side-effect import through barrel — no names, edge preserved correctly", async () => {
    const files = baseProject();
    // Add a file that side-effect-imports the barrel (no named imports)
    files["src/side-effect-consumer.ts"] = 'import "./lib";\n';

    tmpDir = await makeProject(files);
    await seedCache();

    // Modify the side-effect consumer so the incremental path re-parses it
    await fs.writeFile(
      path.join(tmpDir, "src/side-effect-consumer.ts"),
      'import "./lib";\nexport const marker = true;\n',
    );

    const incr = await incrementalRebuild();
    const full = await fullRebuild();
    assertGraphsEqual(incr, full);
  });

  it("16: new barrel file added — incremental detects barrel, routing matches full rebuild", async () => {
    // Start without the new barrel
    const files = baseProject();
    files["src/widgets/button.ts"] = 'export const Button = "button";\n';
    files["src/widgets/input.ts"] = 'export const Input = "input";\n';

    tmpDir = await makeProject(files);
    await seedCache();

    // Add a barrel that re-exports from the two widget files, plus a consumer
    await fs.writeFile(
      path.join(tmpDir, "src/widgets/index.ts"),
      'export { Button } from "./button";\nexport { Input } from "./input";\n',
    );
    await fs.writeFile(
      path.join(tmpDir, "src/widget-consumer.ts"),
      'import { Button } from "./widgets";\nconsole.log(Button);\n',
    );

    const incr = await incrementalRebuild();
    const full = await fullRebuild();
    assertGraphsEqual(incr, full);
  });

  it("17: type-only import routed through barrel carries isTypeOnly flag", async () => {
    const files = baseProject();
    // Add a type-only import of something re-exported by the barrel
    files["src/type-consumer.ts"] = 'import type { User } from "./types";\nexport type { User };\n';

    tmpDir = await makeProject(files);
    await seedCache();

    // Modify the type consumer — incremental path will re-parse and re-route it
    await fs.writeFile(
      path.join(tmpDir, "src/type-consumer.ts"),
      'import type { User, Id } from "./types";\nexport type { User, Id };\n',
    );

    const incr = await incrementalRebuild();
    const full = await fullRebuild();
    assertGraphsEqual(incr, full);
  });
});
