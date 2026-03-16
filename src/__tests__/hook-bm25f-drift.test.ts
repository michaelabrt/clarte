/**
 * Drift detection: ensures the BM25F implementation in generate-hooks.ts
 * (embedded in PROMPT_SCRIPT) stays in sync with the source of truth in
 * resolve-targets.ts.
 *
 * Phase 4 of the adversarial audit found a critical bug where the hook copy
 * diverged from resolve-targets.ts. This test prevents recurrence by
 * extracting key parameters and structural patterns from both files.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const RESOLVE_TARGETS = readFileSync(resolve(ROOT, "steer/targets-resolve.ts"), "utf-8");
const GENERATE_HOOKS = readFileSync(resolve(ROOT, "steer/hooks/generate-hooks.ts"), "utf-8");

/** Extract a numeric constant from resolve-targets.ts */
function extractConst(name: string): number {
  const re = new RegExp(`const ${name}\\s*=\\s*([\\d.]+)`);
  const m = RESOLVE_TARGETS.match(re);
  if (!m) throw new Error(`Constant ${name} not found in resolve-targets.ts`);
  return Number(m[1]);
}

/** Extract the abbreviated constant value from generate-hooks.ts */
function extractHookConst(abbrev: string): number {
  // Hook constants are on a single line: const K1 = 1.2, B = 0.4, PW = 2.0, ...
  const re = new RegExp(`${abbrev}\\s*=\\s*([\\d.]+)`);
  const m = GENERATE_HOOKS.match(re);
  if (!m) throw new Error(`Hook constant ${abbrev} not found in generate-hooks.ts`);
  return Number(m[1]);
}

describe("Hook BM25F drift detection", () => {
  // ── Parameter sync ──────────────────────────────────────────────────

  it("BM25 parameters match", () => {
    expect(extractHookConst("K1")).toBe(extractConst("BM25_K1"));
    expect(extractHookConst("BP")).toBe(extractConst("BM25_B_PATH"));
    expect(extractHookConst("BS")).toBe(extractConst("BM25_B_SYMBOLS"));
    expect(extractHookConst("BI")).toBe(extractConst("BM25_B_IMPORTS"));
  });

  it("field weights match", () => {
    expect(extractHookConst("PW")).toBe(extractConst("PATH_WEIGHT"));
    expect(extractHookConst("SW")).toBe(extractConst("SYMBOL_WEIGHT"));
    expect(extractHookConst("IW")).toBe(extractConst("IMPORT_WEIGHT"));
  });

  it("expansion and coupling factors match", () => {
    expect(extractHookConst("IE")).toBe(extractConst("IMPORTER_EXPANSION"));
    expect(extractHookConst("IM")).toBe(extractConst("IMPORT_EXPANSION"));
    expect(extractHookConst("CF")).toBe(extractConst("COUPLING_FACTOR"));
    expect(extractHookConst("TP")).toBe(extractConst("TEST_PROXY_FACTOR"));
    expect(extractHookConst("SYNONYM_DISCOUNT")).toBe(extractConst("SYNONYM_DISCOUNT"));
    expect(extractHookConst("MC")).toBe(extractConst("MIN_COUPLING_CONFIDENCE"));
    expect(extractHookConst("IC")).toBe(extractConst("IMPORT_CEILING"));
  });

  // ── Synonym group sync ─────────────────────────────────────────────

  it("all synonym terms from resolve-targets exist in hook (and vice versa)", () => {
    // Extract all quoted strings from SYNONYM_GROUPS / SYN_GROUPS sections
    const srcSection = RESOLVE_TARGETS.slice(
      RESOLVE_TARGETS.indexOf("SYNONYM_GROUPS"),
      RESOLVE_TARGETS.indexOf("];", RESOLVE_TARGETS.indexOf("SYNONYM_GROUPS")) + 2,
    );
    const hookSection = GENERATE_HOOKS.slice(
      GENERATE_HOOKS.indexOf("SYN_GROUPS"),
      GENERATE_HOOKS.indexOf("];", GENERATE_HOOKS.indexOf("SYN_GROUPS")) + 2,
    );

    const srcTerms = [...srcSection.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    const hookTerms = [...hookSection.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();

    expect(hookTerms).toEqual(srcTerms);
  });

  // ── Structural patterns ────────────────────────────────────────────

  it("import ceiling logic exists in hook", () => {
    // The ceiling normalization scales import-only scores below path/symbol matches
    expect(GENERATE_HOOKS).toContain("impOnly");
    expect(GENERATE_HOOKS).toMatch(/ceil.*IC|IC.*ceil/i);
  });

  it("fallback-only import pattern exists in hook", () => {
    // Import field should only fire when path/symbol score is 0
    expect(GENERATE_HOOKS).toMatch(/sc\s*===?\s*0/);
    expect(GENERATE_HOOKS).toContain("useImports");
  });

  it("consumer preference tiebreaker exists in hook", () => {
    // 3-tier direction score: consumer (+1) > mixed (0) > provider (-1)
    expect(GENERATE_HOOKS).toMatch(/iSources\.has.*1.*iTargets\.has.*1/s);
  });

  it("stop word lists have same length", () => {
    const srcSection = RESOLVE_TARGETS.slice(
      RESOLVE_TARGETS.indexOf("STOP_WORDS"),
      RESOLVE_TARGETS.indexOf("]);", RESOLVE_TARGETS.indexOf("STOP_WORDS")) + 3,
    );
    const hookSection = GENERATE_HOOKS.slice(
      GENERATE_HOOKS.indexOf("const STOP"),
      GENERATE_HOOKS.indexOf("]);", GENERATE_HOOKS.indexOf("const STOP")) + 3,
    );

    const srcCount = (srcSection.match(/"/g) ?? []).length / 2; // pairs of quotes
    const hookCount = (hookSection.match(/"/g) ?? []).length / 2;

    expect(hookCount).toBe(srcCount);
  });

  // ── Negative guidance pipeline ─────────────────────────────────────

  it("resolveTargets returns up to 10 candidates (needed to populate runnersUp)", () => {
    // The decoy detection pipeline splits allCandidates into targets (0..4)
    // and runnersUp (5..9). If resolveTargets only returned 5, runnersUp
    // would always be empty and no decoy warning would ever be emitted.
    expect(GENERATE_HOOKS).toMatch(/\.slice\(0,\s*10\)\.map/);
  });

  it("runnersUp split preserves correct boundary", () => {
    // Top 5 are the primary targets; positions 6-10 are the candidate decoys.
    expect(GENERATE_HOOKS).toContain("allCandidates.slice(0, 5)");
    expect(GENERATE_HOOKS).toContain("allCandidates.slice(5)");
  });

  it("decoy detection emits Do NOT edit section when basename matches", () => {
    // The negative guidance block must exist so the agent skips same-named
    // files in different directories.
    expect(GENERATE_HOOKS).toContain("Do NOT edit these files");
    expect(GENERATE_HOOKS).toMatch(/targetBasenames\.has\(r\.split.*pop/);
  });
});
