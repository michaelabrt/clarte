/**
 * Structural assertions for the pre-flight agent prompt.
 * Guards the 3-tier task classification and GUIDE format added in the
 * adversarial audit phase 4 improvements.
 */

import { describe, it, expect } from "vitest";
import { PRE_FLIGHT_AGENT_CONTENT } from "../templates/pre-flight-agent.js";

describe("Pre-flight agent prompt - 3-tier task classification", () => {
  it("contains bug fix tier with FILE/LINE/FIX format reference", () => {
    expect(PRE_FLIGHT_AGENT_CONTENT).toMatch(/bug fix.*targeted code change/i);
    expect(PRE_FLIGHT_AGENT_CONTENT).toContain("FILE/LINE");
  });

  it("contains targeted feature tier with GUIDE format reference", () => {
    expect(PRE_FLIGHT_AGENT_CONTENT).toMatch(/targeted feature/i);
    expect(PRE_FLIGHT_AGENT_CONTENT).toMatch(/GUIDE/);
  });

  it("contains open-ended tier with SKIP instruction", () => {
    expect(PRE_FLIGHT_AGENT_CONTENT).toMatch(/open.ended/i);
    expect(PRE_FLIGHT_AGENT_CONTENT).toMatch(/SKIP:/);
  });

  it("defines the GUIDE output format block", () => {
    expect(PRE_FLIGHT_AGENT_CONTENT).toContain("GUIDE: <relative path>");
    expect(PRE_FLIGHT_AGENT_CONTENT).toContain("SECTION:");
    expect(PRE_FLIGHT_AGENT_CONTENT).toContain("WHAT:");
  });

  it("steps mention Do NOT edit section respect", () => {
    expect(PRE_FLIGHT_AGENT_CONTENT).toMatch(/Do NOT edit/);
  });
});
