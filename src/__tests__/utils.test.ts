import { describe, expect, it } from "vitest";
import { estimateTokens } from "../utils.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("uses ~3.5 chars/token for prose text", () => {
    const prose = "This is a simple sentence with mostly words and spaces in it.";
    const tokens = estimateTokens(prose);
    // prose.length = 61, at 3.5 chars/token => ~17-18
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBe(Math.ceil(prose.length / 3.5));
  });

  it("uses ~3.2 chars/token for code-heavy text", () => {
    const code = `const foo = (a: number, b: string) => { return a + b.length; };`;
    const tokens = estimateTokens(code);
    // Code has many symbols (=, :, (, ), {, }, +, ;, .)
    expect(tokens).toBe(Math.ceil(code.length / 3.2));
  });

});
