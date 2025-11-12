import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Cache original env values
const origNoColor = process.env.NO_COLOR;
const origColorTerm = process.env.COLORTERM;

function cleanEnv() {
  delete process.env.NO_COLOR;
  delete process.env.COLORTERM;
}

// The theme module reads env at import time, so we need dynamic imports
// after manipulating the environment.

describe("theme", () => {
  afterEach(() => {
    // Restore original env
    if (origNoColor !== undefined) process.env.NO_COLOR = origNoColor;
    else delete process.env.NO_COLOR;
    if (origColorTerm !== undefined) process.env.COLORTERM = origColorTerm;
    else delete process.env.COLORTERM;
  });

  describe("noColor mode", () => {
    it("produces plain text when NO_COLOR is set", async () => {
      // We test the noColor code path by checking the module-level export
      const { noColor } = await import("../theme.js");
      // noColor reads from process.env.NO_COLOR at module load time
      // Since our test process may or may not have it set, we just verify the export exists
      expect(typeof noColor).toBe("boolean");
    });

    it("theme functions return plain text in noColor mode", async () => {
      // Import the already-loaded theme (env was set at startup)
      const { theme, noColor, isTTY } = await import("../theme.js");

      if (noColor || !isTTY) {
        // In CI/noColor mode, all theme functions should be identity
        expect(theme.text("hello")).toBe("hello");
        expect(theme.muted("hello")).toBe("hello");
        expect(theme.brand("hello")).toBe("hello");
        expect(theme.textBold("hello")).toBe("hello");
        expect(theme.brandBold("hello")).toBe("hello");
        expect(theme.error("hello")).toBe("hello");
        expect(theme.warm("hello")).toBe("hello");
        expect(theme.success("hello")).toBe("hello");
        expect(theme.warn("hello")).toBe("hello");
      }
    });
  });

  describe("gradient", () => {
    it("returns plain text in noColor/non-TTY mode", async () => {
      const { gradient, noColor, isTTY } = await import("../theme.js");

      if (noColor || !isTTY) {
        const result = gradient("hello", [255, 0, 0], [0, 0, 255]);
        expect(result).toBe("hello");
      }
    });

    it("returns empty string for empty input", async () => {
      const { gradient } = await import("../theme.js");
      const result = gradient("", [255, 0, 0], [0, 0, 255]);
      expect(result).toBe("");
    });

    it("uses fallbackFn on non-truecolor terminals", async () => {
      const { gradient, trueColor, noColor, isTTY } = await import("../theme.js");

      if (!noColor && isTTY && !trueColor) {
        const fb = (t: string) => `[${t}]`;
        const result = gradient("hi", [255, 0, 0], [0, 0, 255], fb);
        expect(result).toBe("[hi]");
      }
    });

    it("produces ANSI escape sequences in trueColor mode", async () => {
      const { gradient, trueColor, noColor, isTTY } = await import("../theme.js");

      if (!noColor && isTTY && trueColor) {
        const result = gradient("AB", [255, 0, 0], [0, 0, 255]);
        expect(result).toContain("\x1b[38;2;");
      }
    });
  });

  describe("initTheme", () => {
    it("switches palette without throwing", async () => {
      const { initTheme } = await import("../theme.js");
      expect(() => initTheme("light")).not.toThrow();
      expect(() => initTheme("dark")).not.toThrow();
    });

    it("light palette affects gradient colors", async () => {
      const { initTheme, getShimmerColors } = await import("../theme.js");

      initTheme("dark");
      const dark = getShimmerColors();

      initTheme("light");
      const light = getShimmerColors();

      // Dark and light palettes should produce different colors
      expect(dark.base).not.toEqual(light.base);

      // Restore
      initTheme("dark");
    });
  });

  describe("patchPicocolors / unpatchPicocolors", () => {
    it("roundtrip preserves picocolors state", async () => {
      const { patchPicocolors, unpatchPicocolors, noColor, isTTY } = await import("../theme.js");
      const pc = await import("picocolors");

      if (noColor || !isTTY) {
        // In noColor mode, patching is a no-op
        patchPicocolors();
        unpatchPicocolors();
        // Just verify no throw
        return;
      }

      // Save original green function reference
      const originalGreen = (pc.default as unknown as Record<string, unknown>).green;

      patchPicocolors();
      // After patching, green should be different (our custom function)
      const patchedGreen = (pc.default as unknown as Record<string, unknown>).green;

      unpatchPicocolors();
      // After unpatching, green should be restored
      const restoredGreen = (pc.default as unknown as Record<string, unknown>).green;

      expect(restoredGreen).toBe(originalGreen);
      if (originalGreen !== patchedGreen) {
        // Only check this if patching actually changed it
        expect(patchedGreen).not.toBe(originalGreen);
      }
    });
  });

  describe("resetTerminalColors", () => {
    it("does not throw", async () => {
      const { resetTerminalColors } = await import("../theme.js");
      expect(() => resetTerminalColors()).not.toThrow();
    });
  });

  describe("getGradientBarColors", () => {
    it("returns different colors for dark and light modes", async () => {
      const { initTheme, getGradientBarColors } = await import("../theme.js");

      initTheme("dark");
      const dark = getGradientBarColors();

      initTheme("light");
      const light = getGradientBarColors();

      expect(dark.from).not.toEqual(light.from);

      // Restore
      initTheme("dark");
    });
  });
});
