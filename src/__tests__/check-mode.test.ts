import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProjectConfig } from "../types.js";
import { ExitCode } from "../errors.js";

// Mock dependencies before importing the module under test
vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(),
  computeSnapshotHash: vi.fn(),
}));

vi.mock("../analysis/check.js", () => ({
  validateContextPaths: vi.fn(),
}));

const { loadConfig, computeSnapshotHash } = await import("../config/config.js");
const { validateContextPaths } = await import("../analysis/check.js");
const { runCheckMode } = await import("../cli/check.js");

const mockLoadConfig = vi.mocked(loadConfig);
const mockComputeSnapshotHash = vi.mocked(computeSnapshotHash);
const mockValidateContextPaths = vi.mocked(validateContextPaths);

const ROOT = "/test";

function makeConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    ides: ["claude"],
    projectPurpose: "",
    keyPatterns: "",
    gotchas: "",
    generateSnapshot: false,
    snapshotPaths: [],
    stackCorrections: "",
    generatePerPackage: false,
    ...overrides,
  };
}

/** Sentinel thrown by the process.exit mock to stop function execution. */
class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as typeof process.exit);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

/** Call runCheckMode, capture process.exit code without actually exiting. */
async function runCheck(...args: Parameters<typeof runCheckMode>): Promise<number> {
  try {
    await runCheckMode(...args);
    return -1;
  } catch (e) {
    if (e instanceof ExitCalled) return e.code;
    throw e;
  }
}

// ── Timestamp mode ────────────────────────────────────────────────────

describe("runCheckMode — timestamp mode", () => {
  it("exits MISSING when no config found", async () => {
    mockLoadConfig.mockResolvedValue(null);
    expect(await runCheck(ROOT, true, false)).toBe(ExitCode.MISSING);
  });

  it("exits SUCCESS when config has no snapshotGeneratedAt", async () => {
    mockLoadConfig.mockResolvedValue(makeConfig());
    expect(await runCheck(ROOT, true, false)).toBe(ExitCode.SUCCESS);
  });

  it("exits FAILURE when snapshot is older than staleDays", async () => {
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    mockLoadConfig.mockResolvedValue(makeConfig({ snapshotGeneratedAt: tenDaysAgo, staleDays: 7 }));
    mockValidateContextPaths.mockResolvedValue(null);
    expect(await runCheck(ROOT, true, false)).toBe(ExitCode.FAILURE);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("10d old"));
  });

  it("exits FAILURE with broken paths even when snapshot is fresh", async () => {
    const yesterday = Date.now() - 1 * 24 * 60 * 60 * 1000;
    mockLoadConfig.mockResolvedValue(makeConfig({ snapshotGeneratedAt: yesterday, staleDays: 7 }));
    mockValidateContextPaths.mockResolvedValue({ broken: ["src/missing.ts"], file: "CLAUDE.md" });
    expect(await runCheck(ROOT, true, false)).toBe(ExitCode.FAILURE);
  });

  it("exits SUCCESS when snapshot is fresh and no broken paths", async () => {
    const yesterday = Date.now() - 1 * 24 * 60 * 60 * 1000;
    mockLoadConfig.mockResolvedValue(makeConfig({ snapshotGeneratedAt: yesterday, staleDays: 7 }));
    mockValidateContextPaths.mockResolvedValue({ broken: [], file: "CLAUDE.md" });
    expect(await runCheck(ROOT, true, false)).toBe(ExitCode.SUCCESS);
  });

  it("logs 'none' in CI mode when no config found", async () => {
    mockLoadConfig.mockResolvedValue(null);
    await runCheck(ROOT, true, true);
    expect(logSpy).toHaveBeenCalledWith("none");
  });

  it("logs 'fresh' in CI mode when snapshot is fresh", async () => {
    const yesterday = Date.now() - 1 * 24 * 60 * 60 * 1000;
    mockLoadConfig.mockResolvedValue(makeConfig({ snapshotGeneratedAt: yesterday, staleDays: 7 }));
    mockValidateContextPaths.mockResolvedValue({ broken: [], file: "CLAUDE.md" });
    await runCheck(ROOT, true, true);
    expect(logSpy).toHaveBeenCalledWith("fresh");
  });
});

// ── Hash mode ─────────────────────────────────────────────────────────

describe("runCheckMode — hash mode", () => {
  it("exits MISSING when no config found", async () => {
    mockLoadConfig.mockResolvedValue(null);
    expect(await runCheck(ROOT, false, false)).toBe(ExitCode.MISSING);
  });

  it("exits SUCCESS when config has no snapshotHash", async () => {
    mockLoadConfig.mockResolvedValue(makeConfig());
    expect(await runCheck(ROOT, false, false)).toBe(ExitCode.SUCCESS);
  });

  it("exits FAILURE when hash does not match", async () => {
    mockLoadConfig.mockResolvedValue(makeConfig({ snapshotHash: "old-hash", language: "typescript" }));
    mockComputeSnapshotHash.mockResolvedValue("new-hash");
    mockValidateContextPaths.mockResolvedValue(null);
    expect(await runCheck(ROOT, false, false)).toBe(ExitCode.FAILURE);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("stale"));
  });

  it("exits FAILURE with broken paths even when hash matches", async () => {
    mockLoadConfig.mockResolvedValue(makeConfig({ snapshotHash: "same-hash", language: "typescript" }));
    mockComputeSnapshotHash.mockResolvedValue("same-hash");
    mockValidateContextPaths.mockResolvedValue({ broken: ["src/gone.ts"], file: "CLAUDE.md" });
    expect(await runCheck(ROOT, false, false)).toBe(ExitCode.FAILURE);
  });

  it("exits SUCCESS when hash matches and no broken paths", async () => {
    mockLoadConfig.mockResolvedValue(makeConfig({ snapshotHash: "same-hash", language: "typescript" }));
    mockComputeSnapshotHash.mockResolvedValue("same-hash");
    mockValidateContextPaths.mockResolvedValue({ broken: [], file: "CLAUDE.md" });
    expect(await runCheck(ROOT, false, false)).toBe(ExitCode.SUCCESS);
  });

  it("logs 'stale: hash mismatch' in CI mode", async () => {
    mockLoadConfig.mockResolvedValue(makeConfig({ snapshotHash: "old-hash", language: "typescript" }));
    mockComputeSnapshotHash.mockResolvedValue("new-hash");
    mockValidateContextPaths.mockResolvedValue(null);
    await runCheck(ROOT, false, true);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("stale: hash mismatch"));
  });
});

// ── Error handling ────────────────────────────────────────────────────

describe("runCheckMode — error handling", () => {
  it("exits MISSING and logs error in CI mode when an error is thrown", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockLoadConfig.mockRejectedValue(new Error("disk full"));
    expect(await runCheck(ROOT, false, true)).toBe(ExitCode.MISSING);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  });

  it("re-throws errors in non-CI mode", async () => {
    mockLoadConfig.mockRejectedValue(new Error("unexpected"));
    await expect(runCheckMode(ROOT, false, false)).rejects.toThrow("unexpected");
  });
});
