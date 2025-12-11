import { describe, expect, it } from "vitest";
import { buildClaudeSkills, renderClaudeSkill } from "../templates/claude-skills.js";
import type { ClaudeSkill } from "../types.js";

describe("buildClaudeSkills", () => {
  it("returns exactly 2 skills: check and refresh", () => {
    const skills = buildClaudeSkills();
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name)).toEqual(["check", "refresh"]);
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
