import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Snapshot the real environment once so we can restore it after each test.
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["NO_COLOR", "COLORTERM", "COLORFGBG", "TERM_PROGRAM", "WT_SESSION", "TERM"] as const;
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
const savedIsTTY = process.stdout.isTTY;

/**
 * Set up a deterministic terminal environment for the next dynamic import.
 * Defaults: TTY enabled, no color overrides (trueColor off, color on).
 */
function setupEnv(opts: { tty?: boolean; noColor?: boolean; colorterm?: string } = {}) {
  Object.defineProperty(process.stdout, "isTTY", { value: opts.tty ?? true, configurable: true });
  if (opts.noColor) process.env.NO_COLOR = "1";
  else delete process.env.NO_COLOR;
  if (opts.colorterm) process.env.COLORTERM = opts.colorterm;
  else delete process.env.COLORTERM;
  delete process.env.TERM_PROGRAM;
  delete process.env.WT_SESSION;
  delete process.env.TERM;
}

// The theme module reads env at import time, so every test must
// vi.resetModules(), configure the env, then dynamically import.

describe("theme", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    // Restore original env
    for (const k of ENV_KEYS) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    }
    Object.defineProperty(process.stdout, "isTTY", { value: savedIsTTY, configurable: true });
  });

  describe("noColor mode", () => {
    it("noColor is true when NO_COLOR is set", async () => {
      setupEnv({ noColor: true });
      const { noColor } = await import("../core/theme.js");
      expect(noColor).toBe(true);
    });

    it("noColor is false when NO_COLOR is absent", async () => {
      setupEnv({ noColor: false });
      const { noColor } = await import("../core/theme.js");
      expect(noColor).toBe(false);
    });

    it("theme functions return plain text in noColor mode", async () => {
      setupEnv({ noColor: true });
      const { theme } = await import("../core/theme.js");

      expect(theme.text("hello")).toBe("hello");
      expect(theme.muted("hello")).toBe("hello");
      expect(theme.brand("hello")).toBe("hello");
      expect(theme.textBold("hello")).toBe("hello");
      expect(theme.brandBold("hello")).toBe("hello");
      expect(theme.error("hello")).toBe("hello");
      expect(theme.warm("hello")).toBe("hello");
      expect(theme.success("hello")).toBe("hello");
      expect(theme.warn("hello")).toBe("hello");
    });

    it("theme functions return plain text when not a TTY", async () => {
      setupEnv({ tty: false });
      const { theme } = await import("../core/theme.js");

      expect(theme.text("hello")).toBe("hello");
      expect(theme.muted("hello")).toBe("hello");
      expect(theme.brand("hello")).toBe("hello");
      expect(theme.error("hello")).toBe("hello");
    });
  });

  describe("gradient", () => {
    it("returns plain text in noColor mode", async () => {
      setupEnv({ noColor: true });
      const { gradient } = await import("../core/theme.js");
      expect(gradient("hello", [255, 0, 0], [0, 0, 255])).toBe("hello");
    });

    it("returns plain text when not a TTY", async () => {
      setupEnv({ tty: false });
      const { gradient } = await import("../core/theme.js");
      expect(gradient("hello", [255, 0, 0], [0, 0, 255])).toBe("hello");
    });

    it("returns empty string for empty input", async () => {
      setupEnv({ colorterm: "truecolor" });
      const { gradient } = await import("../core/theme.js");
      expect(gradient("", [255, 0, 0], [0, 0, 255])).toBe("");
    });

    it("uses fallbackFn on non-truecolor terminals", async () => {
      setupEnv(); // TTY on, no COLORTERM => trueColor=false, noColor=false
      const { gradient } = await import("../core/theme.js");
      const fb = (t: string) => `[${t}]`;
      expect(gradient("hi", [255, 0, 0], [0, 0, 255], fb)).toBe("[hi]");
    });

    it("produces ANSI escape sequences in trueColor mode", async () => {
      setupEnv({ colorterm: "truecolor" });
      const { gradient } = await import("../core/theme.js");
      const result = gradient("AB", [255, 0, 0], [0, 0, 255]);
      expect(result).toContain("\x1b[38;2;");
    });
  });

  describe("initTheme", () => {
    it("switches palette without throwing", async () => {
      setupEnv();
      const { initTheme } = await import("../core/theme.js");
      expect(() => initTheme("light")).not.toThrow();
      expect(() => initTheme("dark")).not.toThrow();
    });

    it("light palette produces different shimmer colors than dark", async () => {
      setupEnv();
      const { initTheme, getShimmerColors } = await import("../core/theme.js");

      initTheme("dark");
      const dark = getShimmerColors();

      initTheme("light");
      const light = getShimmerColors();

      expect(dark.base).not.toEqual(light.base);
      expect(dark.highlight).not.toEqual(light.highlight);

      // Restore
      initTheme("dark");
    });
  });

  describe("patchPicocolors / unpatchPicocolors", () => {
    it("patching is a no-op in noColor mode", async () => {
      setupEnv({ noColor: true });
      const { patchPicocolors, unpatchPicocolors } = await import("../core/theme.js");
      const pc = await import("picocolors");
      const obj = pc.default as unknown as Record<string, unknown>;

      const greenBefore = obj.green;
      patchPicocolors();
      expect(obj.green).toBe(greenBefore);
      unpatchPicocolors();
      expect(obj.green).toBe(greenBefore);
    });

    it("roundtrip preserves picocolors state with color enabled", async () => {
      setupEnv({ colorterm: "truecolor" });
      const { patchPicocolors, unpatchPicocolors } = await import("../core/theme.js");
      const pc = await import("picocolors");
      const obj = pc.default as unknown as Record<string, unknown>;

      const originalGreen = obj.green;

      patchPicocolors();
      const patchedGreen = obj.green;
      expect(patchedGreen).not.toBe(originalGreen);

      unpatchPicocolors();
      expect(obj.green).toBe(originalGreen);
    });
  });

  describe("resetTerminalColors", () => {
    it("writes ANSI reset when color is enabled", async () => {
      setupEnv({ colorterm: "truecolor" });
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const { resetTerminalColors } = await import("../core/theme.js");

      resetTerminalColors();
      expect(writeSpy).toHaveBeenCalledWith("\x1b[39m");
      writeSpy.mockRestore();
    });

    it("does not write when noColor is set", async () => {
      setupEnv({ noColor: true });
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const { resetTerminalColors } = await import("../core/theme.js");

      resetTerminalColors();
      expect(writeSpy).not.toHaveBeenCalled();
      writeSpy.mockRestore();
    });
  });

  describe("detectTerminalBackground", () => {
    it("returns null when COLORFGBG is not set", async () => {
      setupEnv();
      delete process.env.COLORFGBG;
      const { detectTerminalBackground } = await import("../core/theme.js");
      expect(detectTerminalBackground()).toBeNull();
    });

    it("returns 'light' for bg index >= 7", async () => {
      setupEnv();
      process.env.COLORFGBG = "0;15";
      const { detectTerminalBackground } = await import("../core/theme.js");
      expect(detectTerminalBackground()).toBe("light");
    });

    it("returns 'dark' for bg index < 7", async () => {
      setupEnv();
      process.env.COLORFGBG = "15;0";
      const { detectTerminalBackground } = await import("../core/theme.js");
      expect(detectTerminalBackground()).toBe("dark");
    });

    it("handles 3-part format (fg;extra;bg)", async () => {
      setupEnv();
      process.env.COLORFGBG = "15;0;8";
      const { detectTerminalBackground } = await import("../core/theme.js");
      expect(detectTerminalBackground()).toBe("light");
    });

    it("returns null for non-numeric values", async () => {
      setupEnv();
      process.env.COLORFGBG = "invalid";
      const { detectTerminalBackground } = await import("../core/theme.js");
      expect(detectTerminalBackground()).toBeNull();
    });
  });

  describe("getGradientBarColors", () => {
    it("returns different colors for dark and light modes", async () => {
      setupEnv();
      const { initTheme, getGradientBarColors } = await import("../core/theme.js");

      initTheme("dark");
      const dark = getGradientBarColors();

      initTheme("light");
      const light = getGradientBarColors();

      expect(dark.from).not.toEqual(light.from);
      expect(dark.to).not.toEqual(light.to);

      // Restore
      initTheme("dark");
    });
  });

  describe("trueColor detection", () => {
    it("COLORTERM=truecolor enables trueColor", async () => {
      setupEnv({ colorterm: "truecolor" });
      const mod = await import("../core/theme.js");
      expect(mod.trueColor).toBe(true);
    });

    it("COLORTERM=24bit enables trueColor", async () => {
      setupEnv({ colorterm: "24bit" });
      const mod = await import("../core/theme.js");
      expect(mod.trueColor).toBe(true);
    });

    it("TERM_PROGRAM=vscode enables trueColor", async () => {
      setupEnv();
      process.env.TERM_PROGRAM = "vscode";
      const mod = await import("../core/theme.js");
      expect(mod.trueColor).toBe(true);
    });

    it("NO_COLOR=1 disables trueColor regardless of COLORTERM", async () => {
      setupEnv({ noColor: true, colorterm: "truecolor" });
      const mod = await import("../core/theme.js");
      expect(mod.trueColor).toBe(false);
    });

    it("trueColor is false when not a TTY even with COLORTERM", async () => {
      setupEnv({ tty: false, colorterm: "truecolor" });
      const mod = await import("../core/theme.js");
      expect(mod.trueColor).toBe(false);
    });

    it("rgb() produces ANSI escape sequences when trueColor is on", async () => {
      setupEnv({ colorterm: "truecolor" });
      const mod = await import("../core/theme.js");
      const result = mod.theme.brand("test");
      expect(result).toContain("\x1b[38;2;");
      expect(result).toContain("test");
    });

    it("gradient() produces per-character ANSI sequences when trueColor is on", async () => {
      setupEnv({ colorterm: "truecolor" });
      const mod = await import("../core/theme.js");
      const result = mod.gradient("AB", [255, 0, 0], [0, 0, 255]);
      const escapeCount = result.split("\x1b[38;2;").length - 1;
      // One escape per character (A and B)
      expect(escapeCount).toBeGreaterThanOrEqual(2);
    });
  });
});
