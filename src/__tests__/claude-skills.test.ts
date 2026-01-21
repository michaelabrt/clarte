import { describe, expect, it } from "vitest";
import { buildClaudeSkills, renderClaudeSkill } from "../templates/claude-skills.js";
import { makeContextAnalysis } from "./helpers/factories.js";
import type { ClaudeSkill } from "../types.js";

describe("buildClaudeSkills", () => {
  it("returns exactly 2 skills: check and refresh", () => {
    const skills = buildClaudeSkills();
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name)).toEqual(["check", "refresh"]);
  });

  it("without analysis or with onDemandSkills=false: exactly 2 skills (backward compat)", () => {
    expect(buildClaudeSkills()).toHaveLength(2);
    expect(buildClaudeSkills(undefined, false)).toHaveLength(2);
    expect(buildClaudeSkills(makeContextAnalysis(), false)).toHaveLength(2);
  });

  it("/check skill is auto-invocable with Bash", () => {
    const skills = buildClaudeSkills();
    const check = skills.find((s) => s.name === "check")!;
    expect(check.disableModelInvocation).toBe(false);
    expect(check.allowedTools).toBe("Bash");
    expect(check.body).toContain("--format=json");
    expect(check.body).toContain("circular dependencies");
  });

  it("/refresh skill is user-invoked with Bash", () => {
    const skills = buildClaudeSkills();
    const refresh = skills.find((s) => s.name === "refresh")!;
    expect(refresh.disableModelInvocation).toBe(true);
    expect(refresh.allowedTools).toBe("Bash");
    expect(refresh.body).toContain("--refresh-snapshot");
  });

  it("with onDemandSkills=true: generates data skills when analysis has data", () => {
    const analysis = makeContextAnalysis({
      tightCouplings: [
        {
          from: "src/a.ts",
          to: "src/b.ts",
          importedNames: 10,
          names: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
        },
      ],
      structuralMismatches: [
        { fileA: "src/c.ts", fileB: "src/d.ts", graphDistance: -1, coChangeConfidence: 0.7, coChangeCount: 5 },
      ],
      deadFiles: ["src/dead.ts"],
      testMapping: {
        sourceToTests: new Map([["src/utils.ts", ["src/__tests__/utils.test.ts"]]]),
        untestedFiles: [],
        testPattern: { framework: "vitest", convention: "co-located", filePattern: "*.test.ts" },
      },
    });

    const skills = buildClaudeSkills(analysis, true);
    const names = skills.map((s) => s.name);
    expect(names).toContain("check");
    expect(names).toContain("refresh");
    expect(names).toContain("coupling");
    expect(names).toContain("health");
    expect(names).toContain("tests");
  });

  it("each data skill is model-invocable (disableModelInvocation=false)", () => {
    const analysis = makeContextAnalysis({
      tightCouplings: [
        {
          from: "src/a.ts",
          to: "src/b.ts",
          importedNames: 10,
          names: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
        },
      ],
      deadFiles: ["src/dead.ts"],
      testMapping: {
        sourceToTests: new Map([["src/x.ts", ["src/__tests__/x.test.ts"]]]),
        untestedFiles: [],
        testPattern: { framework: "vitest", convention: "co-located", filePattern: "*.test.ts" },
      },
    });

    const skills = buildClaudeSkills(analysis, true);
    for (const skill of skills.filter((s) => ["coupling", "health", "tests"].includes(s.name))) {
      expect(skill.disableModelInvocation).toBe(false);
    }
  });

  it("each data skill has correct content from analysis", () => {
    const analysis = makeContextAnalysis({
      tightCouplings: [
        {
          from: "src/a.ts",
          to: "src/b.ts",
          importedNames: 10,
          names: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
        },
      ],
      deadFiles: ["src/dead.ts"],
      testMapping: {
        sourceToTests: new Map([["src/utils.ts", ["src/__tests__/utils.test.ts"]]]),
        untestedFiles: [],
        testPattern: { framework: "vitest", convention: "co-located", filePattern: "*.test.ts" },
      },
    });

    const skills = buildClaudeSkills(analysis, true);
    const coupling = skills.find((s) => s.name === "coupling")!;
    expect(coupling.body).toContain("src/a.ts");
    expect(coupling.body).toContain("Tight Coupling");

    const health = skills.find((s) => s.name === "health")!;
    expect(health.body).toContain("src/dead.ts");
    expect(health.body).toContain("Dead Files");

    const tests = skills.find((s) => s.name === "tests")!;
    expect(tests.body).toContain("src/utils.ts");
  });

  it("each data skill description matches designed descriptions", () => {
    const analysis = makeContextAnalysis({
      tightCouplings: [{ from: "a", to: "b", importedNames: 5, names: ["x", "y", "z", "w", "v"] }],
      deadFiles: ["dead.ts"],
      testMapping: {
        sourceToTests: new Map([["x", ["x.test"]]]),
        untestedFiles: [],
        testPattern: { framework: "vitest", convention: "co-located", filePattern: "*.test.ts" },
      },
    });

    const skills = buildClaudeSkills(analysis, true);
    const coupling = skills.find((s) => s.name === "coupling")!;
    expect(coupling.description).toContain("tight coupling");
    expect(coupling.description).toContain("hidden coupling");
    expect(coupling.description).toContain("change coupling");
    expect(coupling.description).toContain("refactoring");

    const health = skills.find((s) => s.name === "health")!;
    expect(health.description).toContain("dead files");
    expect(health.description).toContain("circular dependency");
    expect(health.description).toContain("chokepoints");

    const tests = skills.find((s) => s.name === "tests")!;
    expect(tests.description).toContain("test coverage");
    expect(tests.description).toContain("untested files");
  });

  it("empty data produces no skill (no tight couplings = no /coupling if no other coupling data)", () => {
    const analysis = makeContextAnalysis();
    const skills = buildClaudeSkills(analysis, true);
    expect(skills.map((s) => s.name)).toEqual(["check", "refresh"]);
  });
});

describe("renderClaudeSkill", () => {
  it("produces valid YAML frontmatter", () => {
    const skill: ClaudeSkill = {
      name: "test",
      description: "Run tests",
      disableModelInvocation: true,
      body: "# Run tests\n\nRun: `npm test`",
    };
    const rendered = renderClaudeSkill(skill);
    expect(rendered).toMatch(/^---\n/);
    expect(rendered).toContain("description: Run tests");
    expect(rendered).toContain("disable-model-invocation: true");
    expect(rendered).toContain("---\n\n# Run tests");
  });

  it("includes allowed-tools when specified", () => {
    const skill: ClaudeSkill = {
      name: "arch",
      description: "Explore architecture",
      disableModelInvocation: false,
      allowedTools: "Read, Grep, Glob",
      body: "# Architecture",
    };
    const rendered = renderClaudeSkill(skill);
    expect(rendered).toContain("allowed-tools: Read, Grep, Glob");
    expect(rendered).not.toContain("disable-model-invocation");
  });

  it("omits disable-model-invocation when false", () => {
    const skill: ClaudeSkill = {
      name: "check",
      description: "Check things",
      disableModelInvocation: false,
      body: "# Check",
    };
    const rendered = renderClaudeSkill(skill);
    expect(rendered).not.toContain("disable-model-invocation");
  });
});
