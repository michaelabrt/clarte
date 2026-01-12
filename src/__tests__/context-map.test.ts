import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import { buildContextMap } from "../hooks/context-map.js";
import { generateHookFiles, configureClaudeHooks } from "../hooks/generate-hooks.js";
import type { PersistedGraph } from "../graph/types.js";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "clarte-hooks-"));
}

async function cleanup(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}

function makeGraph(overrides: Partial<PersistedGraph> = {}): PersistedGraph {
  return {
    version: 1,
    timestamp: new Date().toISOString(),
    files: {},
    edges: [],
    communities: [],
    changeCoupling: [],
    structuralMismatches: [],
    testMapping: {},
    lagCouplings: [],
    ...overrides,
  };
}

function makeFile(overrides: Partial<PersistedGraph["files"][string]> = {}): PersistedGraph["files"][string] {
  return {
    role: "Leaf",
    authority: 0,
    hubScore: 0,
    betweenness: 0,
    instability: null,
    importedByCount: 0,
    isChokepoint: false,
    separatesComponents: 0,
    isCrossCutting: false,
    layerSpread: 0,
    layers: [],
    hasTests: false,
    testFiles: [],
    communityId: null,
    ...overrides,
  };
}

// ── buildContextMap ─────────────────────────────────────────────────────────

describe("buildContextMap", () => {
  it("produces entries only for files above thresholds", () => {
    const graph = makeGraph({
      files: {
        "src/utils.ts": makeFile({ role: "Foundation", betweenness: 0.85, isChokepoint: true, separatesComponents: 5 }),
        "src/leaf.ts": makeFile({ betweenness: 0.01 }),
        "src/mid.ts": makeFile({ betweenness: 0.05 }),
      },
    });

    const map = buildContextMap(graph);
    expect(Object.keys(map)).toEqual(["src/utils.ts"]);
  });

  it("produces no entries when all files are below thresholds", () => {
    const graph = makeGraph({
      files: {
        "src/a.ts": makeFile({ betweenness: 0.05 }),
        "src/b.ts": makeFile({ betweenness: 0.01 }),
      },
    });

    const map = buildContextMap(graph);
    expect(Object.keys(map)).toEqual([]);
  });

  it("includes files with co-change partners even if betweenness is low", () => {
    const graph = makeGraph({
      files: {
        "src/a.ts": makeFile({ betweenness: 0.05 }),
        "src/b.ts": makeFile({ betweenness: 0.02 }),
      },
      changeCoupling: [{ fileA: "src/a.ts", fileB: "src/b.ts", confidence: 0.7, coChangeCount: 10 }],
    });

    const map = buildContextMap(graph);
    expect(map["src/a.ts"]).toBeDefined();
    expect(map["src/b.ts"]).toBeDefined();
  });

  it("includes files with integration tests even if betweenness is low", () => {
    const graph = makeGraph({
      files: {
        "src/a.ts": makeFile({ betweenness: 0.05, testFiles: ["src/__tests__/a.test.ts"] }),
        "src/b.ts": makeFile({ betweenness: 0.05 }),
        "src/__tests__/integration.test.ts": makeFile(),
      },
      edges: [
        { from: "src/b.ts", to: "src/a.ts", importedNames: [] },
        { from: "src/__tests__/integration.test.ts", to: "src/b.ts", importedNames: [] },
      ],
    });

    const map = buildContextMap(graph);
    // src/a.ts has a transitive test (integration.test.ts reaches it via src/b.ts)
    expect(map["src/a.ts"]).toBeDefined();
    expect(map["src/a.ts"]).toContain("tests:");
  });

  it("formats context with role and betweenness", () => {
    const graph = makeGraph({
      files: {
        "src/utils.ts": makeFile({ role: "Foundation", betweenness: 0.85 }),
      },
    });

    const map = buildContextMap(graph);
    expect(map["src/utils.ts"]).toContain("role: Foundation");
    expect(map["src/utils.ts"]).toContain("betweenness: 85%");
  });

  it("formats chokepoint info", () => {
    const graph = makeGraph({
      files: {
        "src/router.ts": makeFile({ betweenness: 0.5, isChokepoint: true, separatesComponents: 7 }),
      },
    });

    const map = buildContextMap(graph);
    expect(map["src/router.ts"]).toContain("chokepoint: 7 files depend through it");
  });

  it("formats co-change partners", () => {
    const graph = makeGraph({
      files: {
        "src/a.ts": makeFile({ betweenness: 0.05 }),
        "src/b.ts": makeFile({ betweenness: 0.05 }),
      },
      changeCoupling: [{ fileA: "src/a.ts", fileB: "src/b.ts", confidence: 0.55, coChangeCount: 8 }],
    });

    const map = buildContextMap(graph);
    expect(map["src/a.ts"]).toContain("cochange: src/b.ts (55%)");
  });
});

// ── generateHookFiles ───────────────────────────────────────────────────────

describe("generateHookFiles", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("generates context-map.json and on-read.mjs", async () => {
    tmpDir = await makeTmpDir();
    const graph = makeGraph({
      files: {
        "src/utils.ts": makeFile({ role: "Foundation", betweenness: 0.85 }),
      },
    });

    await generateHookFiles(tmpDir, graph);

    const mapContent = await fs.readFile(path.join(tmpDir, ".clarte/hooks/context-map.json"), "utf-8");
    const map = JSON.parse(mapContent);
    expect(map["src/utils.ts"]).toBeDefined();

    const script = await fs.readFile(path.join(tmpDir, ".clarte/hooks/on-read.mjs"), "utf-8");
    expect(script).toContain("context-map.json");
    expect(script).toContain("additionalContext");
  });

  it("produces valid ESM hook script with expected structure", async () => {
    tmpDir = await makeTmpDir();
    const graph = makeGraph({ files: {} });

    await generateHookFiles(tmpDir, graph);

    const script = await fs.readFile(path.join(tmpDir, ".clarte/hooks/on-read.mjs"), "utf-8");
    expect(script).toContain("import");
    expect(script).toContain("readFileSync");
    expect(script).toContain("/dev/stdin");
    expect(script).toContain("context-map.json");
    expect(script).toContain("additionalContext");
    expect(script).toContain("tool_input");
  });

  it("generates on-session-start.mjs with model gate", async () => {
    tmpDir = await makeTmpDir();
    const graph = makeGraph({ files: {} });

    await generateHookFiles(tmpDir, graph);

    const script = await fs.readFile(path.join(tmpDir, ".clarte/hooks/on-session-start.mjs"), "utf-8");
    expect(script).toContain("CLAUDE_ENV_FILE");
    expect(script).toContain("haiku");
    expect(script).toContain("CLARTE_HOOKS_DISABLED");
    expect(script).toContain("input.model");
  });

  it("on-read script checks CLARTE_HOOKS_DISABLED", async () => {
    tmpDir = await makeTmpDir();
    const graph = makeGraph({ files: {} });

    await generateHookFiles(tmpDir, graph);

    const script = await fs.readFile(path.join(tmpDir, ".clarte/hooks/on-read.mjs"), "utf-8");
    expect(script).toContain("CLARTE_HOOKS_DISABLED");
  });
});

// ── configureClaudeHooks ────────────────────────────────────────────────────

describe("configureClaudeHooks", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("creates settings file with both SessionStart and PreToolUse hooks", async () => {
    tmpDir = await makeTmpDir();

    await configureClaudeHooks(tmpDir);

    const content = await fs.readFile(path.join(tmpDir, ".claude/settings.json"), "utf-8");
    const settings = JSON.parse(content);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("on-session-start.mjs");
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Read");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("on-read.mjs");
  });

  it("preserves existing hooks", async () => {
    tmpDir = await makeTmpDir();
    await fs.mkdir(path.join(tmpDir, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo custom" }] }],
        },
        someOtherSetting: true,
      }),
    );

    await configureClaudeHooks(tmpDir);

    const content = await fs.readFile(path.join(tmpDir, ".claude/settings.json"), "utf-8");
    const settings = JSON.parse(content);
    expect(settings.someOtherSetting).toBe(true);
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Write");
    expect(settings.hooks.PreToolUse[1].matcher).toBe("Read");
  });

  it("updates existing clarte hook entry", async () => {
    tmpDir = await makeTmpDir();
    await fs.mkdir(path.join(tmpDir, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "node .clarte/hooks/old-script.mjs" }] }],
        },
      }),
    );

    await configureClaudeHooks(tmpDir);

    const content = await fs.readFile(path.join(tmpDir, ".claude/settings.json"), "utf-8");
    const settings = JSON.parse(content);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("on-read.mjs");
  });

  it("handles malformed settings gracefully", async () => {
    tmpDir = await makeTmpDir();
    await fs.mkdir(path.join(tmpDir, ".claude"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".claude/settings.json"), "not valid json");

    await configureClaudeHooks(tmpDir);

    const content = await fs.readFile(path.join(tmpDir, ".claude/settings.json"), "utf-8");
    const settings = JSON.parse(content);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });
});
