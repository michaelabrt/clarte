import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock theme module before importing animations
vi.mock("../core/theme.js", () => ({
  isTTY: false,
  noColor: false,
  trueColor: false,
  getShimmerColors: () => ({
    base: [100, 100, 100] as [number, number, number],
    highlight: [255, 255, 255] as [number, number, number],
  }),
}));

import { startShimmer, NOOP_SHIMMER } from "../cli/animations";

describe("NOOP_SHIMMER", () => {
  it("has a stop method that does not throw", () => {
    expect(() => NOOP_SHIMMER.stop()).not.toThrow();
  });

  it("has a message method that does not throw", () => {
    expect(() => NOOP_SHIMMER.message("any text")).not.toThrow();
  });

  it("conforms to the ShimmerHandle interface", () => {
    expect(typeof NOOP_SHIMMER.stop).toBe("function");
    expect(typeof NOOP_SHIMMER.message).toBe("function");
  });
});

describe("startShimmer", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("returns an object with stop and message methods", () => {
    const handle = startShimmer("Analyzing...");
    expect(handle).toHaveProperty("stop");
    expect(handle).toHaveProperty("message");
    expect(typeof handle.stop).toBe("function");
    expect(typeof handle.message).toBe("function");
    handle.stop();
  });

  it("writes text to stdout in non-TTY mode", () => {
    const handle = startShimmer("Working...");
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Working..."));
    handle.stop();
  });

  it("stop() writes a clear sequence", () => {
    const handle = startShimmer("Test");
    writeSpy.mockClear();
    handle.stop();
    // Non-TTY stop writes cursor-up + clear-line
    expect(writeSpy).toHaveBeenCalled();
  });

  it("message() is a no-op in non-TTY mode", () => {
    const handle = startShimmer("Initial");
    writeSpy.mockClear();
    handle.message("Updated");
    // In non-TTY mode, message() does nothing
    expect(writeSpy).not.toHaveBeenCalled();
    handle.stop();
  });

  it("accepts custom options without error", () => {
    const handle = startShimmer("Custom", {
      indent: ">>> ",
      width: 10,
    });
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Custom"));
    handle.stop();
  });
});

describe("startShimmer TTY mode", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.useFakeTimers();

    // Override mock to enable TTY mode
    const theme = await import("../core/theme.js");
    Object.defineProperty(theme, "isTTY", { value: true, writable: true });
    Object.defineProperty(theme, "noColor", { value: false, writable: true });
    Object.defineProperty(theme, "trueColor", { value: false, writable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    writeSpy.mockRestore();
  });

  it("starts interval-based animation in TTY mode", async () => {
    const theme = await import("../core/theme.js");
    Object.defineProperty(theme, "isTTY", { value: true });

    const handle = startShimmer("Scanning...");

    // Advance timers to trigger frame rendering
    vi.advanceTimersByTime(150);

    // Should have written initial hide-cursor + at least one frame
    expect(writeSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    handle.stop();
  });

  it("stop() clears interval and shows cursor in TTY mode", async () => {
    const theme = await import("../core/theme.js");
    Object.defineProperty(theme, "isTTY", { value: true });

    const handle = startShimmer("Test");
    handle.stop();

    // Last write should contain show-cursor escape
    const lastCall = writeSpy.mock.calls[writeSpy.mock.calls.length - 1];
    expect(lastCall[0]).toContain("\x1b[?25h");
  });
});
