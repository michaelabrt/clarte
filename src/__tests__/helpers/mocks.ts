import { vi } from "vitest";
export { makeDetectedContext } from "./factories.js";

/**
 * Shared theme mock: identity functions for all theme properties.
 * Use with vi.mock("../theme.js", () => ({ theme: THEME_MOCK }))
 */
export const THEME_MOCK = {
  text: (s: string) => s,
  textBold: (s: string) => s,
  accent: (s: string) => s,
  muted: (s: string) => s,
  brand: (s: string) => s,
  brandBold: (s: string) => s,
  warn: (s: string) => s,
  success: (s: string) => s,
  error: (s: string) => s,
  check: () => "\u2713",
  bold: (s: string) => s,
  soft: (s: string) => s,
};

/**
 * Create a @clack/prompts mock with optional log capture.
 * When captureLogs is true, all log calls are stored in the returned logCalls array.
 */
export function createClackMock(opts: { captureLogs?: boolean } = {}) {
  const logCalls: Array<{ method: string; args: unknown[] }> = [];

  const makeLogFn = (method: string) => {
    if (opts.captureLogs) {
      return vi.fn((...args: unknown[]) => {
        logCalls.push({ method, args });
      });
    }
    return vi.fn();
  };

  return {
    logCalls,
    mock: {
      log: {
        info: makeLogFn("info"),
        step: makeLogFn("step"),
        warn: makeLogFn("warn"),
        error: makeLogFn("error"),
        message: makeLogFn("message"),
        success: makeLogFn("success"),
      },
      note: vi.fn(),
      outro: vi.fn(),
      intro: vi.fn(),
      confirm: vi.fn(),
      isCancel: vi.fn(() => false),
    },
  };
}
