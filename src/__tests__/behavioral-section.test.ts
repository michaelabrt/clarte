import { describe, it, expect } from "vitest";
import { renderBehavioralSection } from "../templates/sections/behavioral.js";

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
