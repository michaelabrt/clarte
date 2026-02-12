import { describe, it, expect } from "vitest";
import { renderBehavioralSection, renderNegativeBehavioralSection } from "../templates/sections/behavioral.js";

describe("renderBehavioralSection", () => {
  it("returns a section with id 'behavioral' and priority 1", () => {
    const section = renderBehavioralSection();
    expect(section.id).toBe("behavioral");
    expect(section.priority).toBe(1);
  });

  it("contains the expected behavioral guidance text", () => {
    const section = renderBehavioralSection();
    expect(section.content).toContain("Do not use Grep or Glob to explore");
    expect(section.content).toContain("open the most relevant files directly");
    expect(section.content).toContain("run tests once");
  });

  it("has a positive token estimate", () => {
    const section = renderBehavioralSection();
    expect(section.tokens).toBeGreaterThan(0);
  });
});

describe("renderNegativeBehavioralSection", () => {
  it("returns a section with id 'behavioral' and priority 1", () => {
    const section = renderNegativeBehavioralSection();
    expect(section.id).toBe("behavioral");
    expect(section.priority).toBe(1);
  });

  it("contains constraint framing with NEVER", () => {
    const section = renderNegativeBehavioralSection();
    expect(section.content).toContain("NEVER search the codebase");
    expect(section.content).toContain("Do not create new files");
    expect(section.content).toContain("Do not add comments");
    expect(section.content).toContain("NEVER re-run tests");
  });

  it("has a positive token estimate", () => {
    const section = renderNegativeBehavioralSection();
    expect(section.tokens).toBeGreaterThan(0);
  });
});
