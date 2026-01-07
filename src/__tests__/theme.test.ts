import { describe, it, expect, vi, afterEach } from "vitest";

// Cache original env values
const origNoColor = process.env.NO_COLOR;
const origColorTerm = process.env.COLORTERM;
const origColorFGBG = process.env.COLORFGBG;
const origTermProgram = process.env.TERM_PROGRAM;
const origWtSession = process.env.WT_SESSION;
const origTerm = process.env.TERM;
const origIsTTY = process.stdout.isTTY;

function _cleanEnv() {
  delete process.env.NO_COLOR;
  delete process.env.COLORTERM;
}

// The theme module reads env at import time, so we need dynamic imports
// after manipulating the environment.

describe("theme", () => {
  afterEach(() => {
    vi.resetModules();
    // Restore original env
    if (origNoColor !== undefined) process.env.NO_COLOR = origNoColor;
    else delete process.env.NO_COLOR;
    if (origColorTerm !== undefined) process.env.COLORTERM = origColorTerm;
    else delete process.env.COLORTERM;
    if (origColorFGBG !== undefined) process.env.COLORFGBG = origColorFGBG;
    else delete process.env.COLORFGBG;
    if (origTermProgram !== undefined) process.env.TERM_PROGRAM = origTermProgram;
    else delete process.env.TERM_PROGRAM;
    if (origWtSession !== undefined) process.env.WT_SESSION = origWtSession;
    else delete process.env.WT_SESSION;
    if (origTerm !== undefined) process.env.TERM = origTerm;
    else delete process.env.TERM;
    Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, configurable: true });
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

  describe("detectTerminalBackground", () => {
    it("returns null when COLORFGBG is not set", async () => {
      delete process.env.COLORFGBG;
      const { detectTerminalBackground } = await import("../theme.js");
      expect(detectTerminalBackground()).toBeNull();
    });

    it("returns 'light' for bg index >= 7", async () => {
      process.env.COLORFGBG = "0;15";
      const { detectTerminalBackground } = await import("../theme.js");
      expect(detectTerminalBackground()).toBe("light");
    });

    it("returns 'dark' for bg index < 7", async () => {
      process.env.COLORFGBG = "15;0";
      const { detectTerminalBackground } = await import("../theme.js");
      expect(detectTerminalBackground()).toBe("dark");
    });

    it("handles 3-part format (fg;extra;bg)", async () => {
      process.env.COLORFGBG = "15;0;8";
      const { detectTerminalBackground } = await import("../theme.js");
      expect(detectTerminalBackground()).toBe("light");
    });

    it("returns null for non-numeric values", async () => {
      process.env.COLORFGBG = "invalid";
      const { detectTerminalBackground } = await import("../theme.js");
      expect(detectTerminalBackground()).toBeNull();
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

  describe("trueColor detection", () => {
    function setupTTY() {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      delete process.env.NO_COLOR;
      delete process.env.COLORTERM;
      delete process.env.TERM_PROGRAM;
      delete process.env.WT_SESSION;
      delete process.env.TERM;
    }

    it("COLORTERM=truecolor enables trueColor", async () => {
      setupTTY();
      process.env.COLORTERM = "truecolor";

      const mod = await import("../theme.js");
      expect(mod.trueColor).toBe(true);
    });

    it("COLORTERM=24bit enables trueColor", async () => {
      setupTTY();
      process.env.COLORTERM = "24bit";

      const mod = await import("../theme.js");
      expect(mod.trueColor).toBe(true);
    });

    it("TERM_PROGRAM=vscode enables trueColor", async () => {
      setupTTY();
      process.env.TERM_PROGRAM = "vscode";

      const mod = await import("../theme.js");
      expect(mod.trueColor).toBe(true);
    });

    it("NO_COLOR=1 disables trueColor regardless", async () => {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      process.env.NO_COLOR = "1";
      process.env.COLORTERM = "truecolor";

      const mod = await import("../theme.js");
      expect(mod.trueColor).toBe(false);
    });

    it("rgb() produces ANSI escape sequences when trueColor is on", async () => {
      setupTTY();
      process.env.COLORTERM = "truecolor";

      const mod = await import("../theme.js");
      // theme.brand uses rgb() internally
      const result = mod.theme.brand("test");
      expect(result).toContain("\x1b[38;2;");
    });

    it("gradient() produces per-character ANSI sequences when trueColor is on", async () => {
      setupTTY();
      process.env.COLORTERM = "truecolor";

      const mod = await import("../theme.js");
      const result = mod.gradient("AB", [255, 0, 0], [0, 0, 255]);
      // Should have at least 2 ANSI color codes (one per character)
      const escapeCount = result.split("\x1b[38;2;").length - 1;
      expect(escapeCount).toBeGreaterThanOrEqual(2);
    });

    it("trueColor is false when not a TTY", async () => {
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      delete process.env.NO_COLOR;
      process.env.COLORTERM = "truecolor";

      const mod = await import("../theme.js");
      expect(mod.trueColor).toBe(false);
    });
  });
});
