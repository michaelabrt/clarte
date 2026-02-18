import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import { buildContextMap } from "../hooks/context-map.js";
import { generateHookFiles, configureClaudeHooks } from "../hooks/generate-hooks.js";
import { makePersistedGraph, makeFileRecord } from "./helpers/factories.js";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "clarte-hooks-"));
}

async function cleanup(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}

// ── buildContextMap ─────────────────────────────────────────────────────────

describe("buildContextMap", () => {
  it("produces entries only for files above thresholds", () => {
    const graph = makePersistedGraph({
      files: {
        "src/utils.ts": makeFileRecord({
          role: "Foundation",
          betweenness: 0.85,
          isChokepoint: true,
          separatesComponents: 5,
        }),
        "src/leaf.ts": makeFileRecord({ betweenness: 0.01 }),
        "src/mid.ts": makeFileRecord({ betweenness: 0.05 }),
      },
    });

    const map = buildContextMap(graph);
    expect(Object.keys(map)).toEqual(["src/utils.ts"]);
  });

  it("produces no entries when all files are below thresholds", () => {
    const graph = makePersistedGraph({
      files: {
        "src/a.ts": makeFileRecord({ betweenness: 0.05 }),
        "src/b.ts": makeFileRecord({ betweenness: 0.01 }),
      },
    });

    const map = buildContextMap(graph);
    expect(Object.keys(map)).toEqual([]);
  });

  it("includes files with co-change partners even if betweenness is low", () => {
    const graph = makePersistedGraph({
      files: {
        "src/a.ts": makeFileRecord({ betweenness: 0.05 }),
        "src/b.ts": makeFileRecord({ betweenness: 0.02 }),
      },
      changeCoupling: [{ fileA: "src/a.ts", fileB: "src/b.ts", confidence: 0.7, coChangeCount: 10 }],
    });

    const map = buildContextMap(graph);
    expect(map["src/a.ts"]).toBeDefined();
    expect(map["src/b.ts"]).toBeDefined();
  });

  it("includes files with integration tests even if betweenness is low", () => {
    const graph = makePersistedGraph({
      files: {
        "src/a.ts": makeFileRecord({ betweenness: 0.05, testFiles: ["src/__tests__/a.test.ts"] }),
        "src/b.ts": makeFileRecord({ betweenness: 0.05 }),
        "src/__tests__/integration.test.ts": makeFileRecord(),
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
    const graph = makePersistedGraph({
      files: {
        "src/utils.ts": makeFileRecord({ role: "Foundation", betweenness: 0.85 }),
      },
    });

    const map = buildContextMap(graph);
    expect(map["src/utils.ts"]).toContain("role: Foundation");
    expect(map["src/utils.ts"]).toContain("betweenness: 85%");
  });

  it("formats chokepoint info", () => {
    const graph = makePersistedGraph({
      files: {
        "src/router.ts": makeFileRecord({ betweenness: 0.5, isChokepoint: true, separatesComponents: 7 }),
      },
    });

    const map = buildContextMap(graph);
    expect(map["src/router.ts"]).toContain("chokepoint: 7 files depend through it");
  });

  it("formats co-change partners", () => {
    const graph = makePersistedGraph({
      files: {
        "src/a.ts": makeFileRecord({ betweenness: 0.05 }),
        "src/b.ts": makeFileRecord({ betweenness: 0.05 }),
      },
      changeCoupling: [{ fileA: "src/a.ts", fileB: "src/b.ts", confidence: 0.55, coChangeCount: 8 }],
    });

    const map = buildContextMap(graph);
    expect(map["src/a.ts"]).toContain("cochange: src/b.ts (55%)");
  });
  it("enriched=false produces unchanged output (backward compat)", () => {
    const graph = makePersistedGraph({
      files: {
        "src/utils.ts": makeFileRecord({
          role: "Foundation",
          betweenness: 0.85,
          instability: 0.3,
          layers: ["utils"],
        }),
      },
    });

    const mapDefault = buildContextMap(graph);
    const mapExplicit = buildContextMap(graph, false);
    expect(mapDefault).toEqual(mapExplicit);
    // Should not contain enriched fields
    expect(mapDefault["src/utils.ts"]).not.toContain("instability:");
    expect(mapDefault["src/utils.ts"]).not.toContain("layers:");
  });

  it("enriched=true includes instability when >= 0.6", () => {
    const graph = makePersistedGraph({
      files: {
        "src/core/a.ts": makeFileRecord({
          role: "Utility",
          betweenness: 0.5,
          instability: 0.85,
          layers: ["core"],
        }),
      },
    });

    const map = buildContextMap(graph, true);
    expect(map["src/core/a.ts"]).toContain("instability: 85%");
    expect(map["src/core/a.ts"]).toContain("layers: core");
  });

  it("enriched=true excludes instability below 0.6", () => {
    const graph = makePersistedGraph({
      files: {
        "src/utils.ts": makeFileRecord({
          role: "Foundation",
          betweenness: 0.85,
          instability: 0.3,
          layers: ["utils"],
        }),
      },
    });

    const map = buildContextMap(graph, true);
    expect(map["src/utils.ts"]).not.toContain("instability:");
    // But layers should still be there
    expect(map["src/utils.ts"]).toContain("layers: utils");
  });

  it("enriched=true includes tight coupling partners", () => {
    const graph = makePersistedGraph({
      files: {
        "src/a.ts": makeFileRecord({ betweenness: 0.5 }),
        "src/b.ts": makeFileRecord({ betweenness: 0.3 }),
      },
      edges: [{ from: "src/a.ts", to: "src/b.ts", importedNames: ["x1", "x2", "x3", "x4", "x5"] }],
    });

    const map = buildContextMap(graph, true);
    expect(map["src/a.ts"]).toContain("tight-coupling: src/b.ts (5 names)");
  });

  it("enriched=true includes per-file directives", () => {
    const graph = makePersistedGraph({
      files: {
        "src/utils.ts": makeFileRecord({ role: "Foundation", betweenness: 0.85 }),
      },
    });

    const directives = ["When modifying `src/utils.ts`, check dependents for breaking changes."];
    const map = buildContextMap(graph, true, directives);
    expect(map["src/utils.ts"]).toContain("directive: When modifying");
  });

  it("enriched=true caps directives per file at 2", () => {
    const graph = makePersistedGraph({
      files: {
        "src/utils.ts": makeFileRecord({ role: "Foundation", betweenness: 0.85 }),
      },
    });

    const directives = [
      "When modifying `src/utils.ts`, check A.",
      "When modifying `src/utils.ts`, check B.",
      "When modifying `src/utils.ts`, check C.",
    ];
    const map = buildContextMap(graph, true, directives);
    const directiveLines = map["src/utils.ts"].split("\n").filter((l: string) => l.startsWith("directive:"));
    expect(directiveLines).toHaveLength(2);
  });
});

// ── generateHookFiles ───────────────────────────────────────────────────────

describe("generateHookFiles", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("generates on-fail-fast.mjs", async () => {
    tmpDir = await makeTmpDir();
    const graph = makePersistedGraph({ files: {} });

    await generateHookFiles(tmpDir, graph);

    const script = await fs.readFile(path.join(tmpDir, ".clarte/hooks/on-fail-fast.mjs"), "utf-8");
    expect(script).toContain("permissionDecision");
    expect(script).toContain("CLARTE_HOOKS_DISABLED");
    expect(script).toContain("fail-fast.json");
    expect(script).toContain("fail-fast-override");
  });

  it("generates context-map.json", async () => {
    tmpDir = await makeTmpDir();
    const graph = makePersistedGraph({
      files: {
        "src/utils.ts": makeFileRecord({ role: "Foundation", betweenness: 0.85 }),
      },
    });

    await generateHookFiles(tmpDir, graph);

    const mapContent = await fs.readFile(path.join(tmpDir, ".clarte/hooks/context-map.json"), "utf-8");
    const map = JSON.parse(mapContent);
    expect(map["src/utils.ts"]).toBeDefined();
  });

  it("generates on-session-start.mjs with model gate and state cleanup", async () => {
    tmpDir = await makeTmpDir();
    const graph = makePersistedGraph({ files: {} });

    await generateHookFiles(tmpDir, graph);

    const script = await fs.readFile(path.join(tmpDir, ".clarte/hooks/on-session-start.mjs"), "utf-8");
    expect(script).toContain("CLAUDE_ENV_FILE");
    expect(script).toContain("haiku");
    expect(script).toContain("CLARTE_HOOKS_DISABLED");
    expect(script).toContain("input.model");
    expect(script).toContain(".clarte/hooks/.state");
    expect(script).toContain("rmSync");
  });

  it("on-session-start.mjs always clears fail-fast.json", async () => {
    tmpDir = await makeTmpDir();
    const graph = makePersistedGraph({ files: {} });

    await generateHookFiles(tmpDir, graph);

    const script = await fs.readFile(path.join(tmpDir, ".clarte/hooks/on-session-start.mjs"), "utf-8");
    expect(script).toContain("fail-fast.json");
  });

  it("on-session-start.mjs uses resolve() for all paths", async () => {
    tmpDir = await makeTmpDir();
    const graph = makePersistedGraph({ files: {} });

    await generateHookFiles(tmpDir, graph);

    const script = await fs.readFile(path.join(tmpDir, ".clarte/hooks/on-session-start.mjs"), "utf-8");
    expect(script).toContain("resolve(");
    // Should not use bare relative paths like ".clarte/hooks/.state" without resolve()
    // Every reference to the state dir should go through resolve()
    const stateRefWithoutResolve = /(?<!resolve\([^)]*)"\.clarte\/hooks\/\.state"/.test(script);
    expect(stateRefWithoutResolve).toBe(false);
  });
});

// ── configureClaudeHooks ────────────────────────────────────────────────────

describe("configureClaudeHooks", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("creates settings file with SessionStart and PreToolUse hooks", async () => {
    tmpDir = await makeTmpDir();

    await configureClaudeHooks(tmpDir);

    const content = await fs.readFile(path.join(tmpDir, ".claude/settings.json"), "utf-8");
    const settings = JSON.parse(content);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("on-session-start.mjs");
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("on-fail-fast.mjs");
    expect(settings.hooks.PreToolUse[0].matcher).toBeUndefined();
    expect(settings.hooks.PreToolUse[1].hooks[0].command).toContain("on-pre-flight-limit.mjs");
    expect(settings.hooks.SubagentStart).toHaveLength(1);
    expect(settings.hooks.SubagentStart[0].matcher).toBe("clarte-pre-flight");
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
    expect(settings.hooks.PreToolUse).toHaveLength(3);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Write");
    const failFast2 = settings.hooks.PreToolUse.find(
      (h: { matcher?: string; hooks: { command: string }[] }) =>
        !h.matcher && h.hooks[0].command.includes("on-fail-fast.mjs"),
    );
    expect(failFast2).toBeDefined();
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
    // Old clarte hook cleaned up, replaced with fail-fast + pre-flight-limit
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    const failFast3 = settings.hooks.PreToolUse.find(
      (h: { matcher?: string; hooks: { command: string }[] }) =>
        !h.matcher && h.hooks[0].command.includes("on-fail-fast.mjs"),
    );
    expect(failFast3).toBeDefined();
  });

  it("repairs corrupted settings with clobbered hooks", async () => {
    tmpDir = await makeTmpDir();
    await fs.mkdir(path.join(tmpDir, ".claude"), { recursive: true });
    // Simulate clobber bug: a single PreToolUse entry with the wrong script
    // (on-read.mjs was overwritten by a second hook registration)
    await fs.writeFile(
      path.join(tmpDir, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "node .clarte/hooks/on-session-start.mjs" }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "node .clarte/hooks/on-session-start.mjs" }] }],
        },
      }),
    );

    await configureClaudeHooks(tmpDir);

    const content = await fs.readFile(path.join(tmpDir, ".claude/settings.json"), "utf-8");
    const settings = JSON.parse(content);
    // Should have exactly 2 PreToolUse hooks (fail-fast + pre-flight-limit) and 1 SessionStart
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    const failFast4 = settings.hooks.PreToolUse.find(
      (h: { matcher?: string; hooks: { command: string }[] }) =>
        !h.matcher && h.hooks[0].command.includes("on-fail-fast.mjs"),
    );
    expect(failFast4).toBeDefined();
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("on-session-start.mjs");
  });

  it("removes legacy PostToolUse MCP hook from previous installs", async () => {
    tmpDir = await makeTmpDir();
    await fs.mkdir(path.join(tmpDir, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "mcp__clarte__clarte_context|mcp__clarte__clarte_search",
              hooks: [{ type: "command", command: "node .clarte/hooks/on-mcp-post.mjs" }],
            },
          ],
        },
      }),
    );

    await configureClaudeHooks(tmpDir);

    const content = await fs.readFile(path.join(tmpDir, ".claude/settings.json"), "utf-8");
    const settings = JSON.parse(content);
    const postToolUse = settings.hooks?.PostToolUse ?? [];
    const hasClarteMcpHook = postToolUse.some((h: { hooks: { command: string }[] }) =>
      h.hooks?.some((e) => e.command?.includes("on-mcp-post.mjs")),
    );
    expect(hasClarteMcpHook).toBe(false);
  });

  it("handles malformed settings gracefully", async () => {
    tmpDir = await makeTmpDir();
    await fs.mkdir(path.join(tmpDir, ".claude"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".claude/settings.json"), "not valid json");

    await configureClaudeHooks(tmpDir);

    const content = await fs.readFile(path.join(tmpDir, ".claude/settings.json"), "utf-8");
    const settings = JSON.parse(content);
    expect(settings.hooks.PreToolUse).toHaveLength(2);
  });
});
