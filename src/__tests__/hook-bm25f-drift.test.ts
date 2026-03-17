/**
 * Verifies the hook bundle exists and re-exports the expected scoring library.
 *
 * Previously this file contained drift detection tests to keep the PROMPT_SCRIPT's
 * inlined BM25F implementation in sync with targets-resolve.ts. Since the hook now
 * imports from a pre-built bundle (bm25f.mjs), there is no duplication to drift.
 * The behavioral equivalence test remains as a regression guard.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveEditTargets, promptMentionsTargets, shouldSkipPreFlight } from "../steer/targets-resolve";
import { makePersistedGraph, makeFileRecord } from "./helpers/factories";

const ROOT = resolve(import.meta.dirname, "..");
const GENERATE_HOOKS = readFileSync(resolve(ROOT, "steer/hooks/generate-hooks.ts"), "utf-8");

describe("Hook bundle integration", () => {
  it("PROMPT_SCRIPT imports from ./bm25f.mjs (no inlined scoring)", () => {
    expect(GENERATE_HOOKS).toContain('from "./bm25f.mjs"');
  });

  it("PROMPT_SCRIPT has no inlined BM25F constants", () => {
    // These were the old SYNC markers; none should remain
    expect(GENERATE_HOOKS).not.toContain("// SYNC:");
  });

  it("PROMPT_SCRIPT has no inlined scoring functions", () => {
    // scoreBM25F, buildDoc, tokId, resolveTargets were all inlined before
    expect(GENERATE_HOOKS).not.toMatch(/function scoreBM25F/);
    expect(GENERATE_HOOKS).not.toMatch(/function buildDoc/);
    expect(GENERATE_HOOKS).not.toMatch(/function tokId/);
    expect(GENERATE_HOOKS).not.toMatch(/function resolveTargets/);
  });

  it("PROMPT_SCRIPT uses library shouldSkipPreFlight instead of inline check", () => {
    expect(GENERATE_HOOKS).toContain("shouldSkipPreFlight");
    // Should not have the old inline TRIVIAL set
    expect(GENERATE_HOOKS).not.toMatch(/const TRIVIAL = new Set/);
  });
});

describe("promptMentionsTargets - negation detection", () => {
  it("returns true for plain file mention", () => {
    expect(promptMentionsTargets("fix bug in src/auth.ts", ["src/auth.ts"])).toBe(true);
  });

  it("returns true for basename mention (>3 chars)", () => {
    expect(promptMentionsTargets("fix the login module", ["src/services/login.ts"])).toBe(true);
  });

  it("returns false when preceded by negation", () => {
    expect(promptMentionsTargets("do not edit src/auth.ts", ["src/auth.ts"])).toBe(false);
  });

  it("returns false with don't negation", () => {
    expect(promptMentionsTargets("don't touch src/auth.ts", ["src/auth.ts"])).toBe(false);
  });

  it("returns true when negation is too far away (>30 chars)", () => {
    const filler = "a".repeat(40);
    expect(promptMentionsTargets(`not ${filler} src/auth.ts`, ["src/auth.ts"])).toBe(true);
  });
});

describe("shouldSkipPreFlight", () => {
  it("skips empty prompt", () => {
    expect(shouldSkipPreFlight("")).toBe(true);
  });

  it("skips short prompt", () => {
    expect(shouldSkipPreFlight("fix it")).toBe(true);
  });

  it("skips trivial responses", () => {
    expect(shouldSkipPreFlight("yes")).toBe(true);
    expect(shouldSkipPreFlight("LGTM")).toBe(true);
    expect(shouldSkipPreFlight("  ok  ")).toBe(true);
  });

  it("does not skip real prompts", () => {
    expect(shouldSkipPreFlight("fix the auth bug in login")).toBe(false);
  });
});

// ── Behavioral equivalence (retained from original) ────────────────────────

describe("Library behavioral equivalence", () => {
  it("resolveEditTargets produces expected ranking", () => {
    const graph = makePersistedGraph({
      files: {
        "src/auth/login.ts": makeFileRecord({ role: null, symbolNames: ["authenticate", "validateToken"] }),
        "src/auth/session.ts": makeFileRecord({ role: null, symbolNames: ["createSession"] }),
        "src/db/users.ts": makeFileRecord({ role: null, symbolNames: ["findUser"] }),
        "src/utils/hash.ts": makeFileRecord({ role: null, symbolNames: ["hashPassword"] }),
        "src/core/engine.ts": makeFileRecord({ role: null }),
      },
      edges: [
        { from: "src/auth/login.ts", to: "src/db/users.ts", importedNames: ["findUser"] },
        { from: "src/auth/login.ts", to: "src/utils/hash.ts", importedNames: ["hashPassword"] },
        { from: "src/auth/session.ts", to: "src/auth/login.ts", importedNames: ["authenticate"] },
      ],
      changeCoupling: [{ fileA: "src/auth/login.ts", fileB: "src/auth/session.ts", confidence: 0.9, coChangeCount: 8 }],
    });

    const targets = resolveEditTargets("auth login token", graph, 5);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets[0]).toBe("src/auth/login.ts");
    expect(targets).toContain("src/auth/session.ts");
  });

  it("resolveEditTargets returns up to 10 candidates for runners-up split", () => {
    const files: Record<string, ReturnType<typeof makeFileRecord>> = {};
    for (let i = 0; i < 15; i++) {
      files[`src/auth-${i}.ts`] = makeFileRecord({ role: null });
    }
    const graph = makePersistedGraph({ files });
    const targets = resolveEditTargets("auth", graph, 10);
    expect(targets.length).toBeLessThanOrEqual(10);
    expect(targets.length).toBeGreaterThan(5);
  });
});
