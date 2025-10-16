import { describe, expect, it } from "vitest";
import { estimateTokens } from "../utils.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates reasonable token count for prose text", () => {
    const prose = "This is a simple sentence with mostly words and spaces in it.";
    const tokens = estimateTokens(prose);
    // ~61 chars of prose should produce roughly 15-25 tokens (1-1.5 tokens per word)
    expect(tokens).toBeGreaterThanOrEqual(15);
    expect(tokens).toBeLessThanOrEqual(25);
  });

  it("estimates higher token density for code-heavy text", () => {
    const code = `const foo = (a: number, b: string) => { return a + b.length; };`;
    const tokens = estimateTokens(code);
    // Code with many symbols should produce more tokens per character than prose
    expect(tokens).toBeGreaterThanOrEqual(15);
    expect(tokens).toBeLessThanOrEqual(30);

    // Code should have a higher token-per-char ratio than equivalently-sized prose
    const proseOfSameLength = "a".repeat(code.length);
    const proseTokens = estimateTokens(proseOfSameLength);
    expect(tokens).toBeGreaterThanOrEqual(proseTokens);
  });

});
