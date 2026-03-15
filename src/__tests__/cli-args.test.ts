import { describe, expect, it, vi, beforeEach } from "vitest";
import { parseCliArgs } from "../cli/args.js";
import { ClarteError } from "../errors.js";

// Suppress process.exit and console.error during tests (handleEarlyExits calls them)
vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseCliArgs", () => {
  it("parses empty args to defaults", () => {
    const result = parseCliArgs([]);
    expect(result.yes).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.refresh).toBe(false);
    expect(result.reconfigure).toBe(false);
    expect(result.check).toBe(false);
    expect(result.checkTimestamp).toBe(false);
    expect(result.ciMode).toBe(false);
    expect(result.verbose).toBe(false);
    expect(result.maxTokens).toBeUndefined();
    expect(result.jsonMode).toBe(false);
    expect(result.effectiveBudget).toBeUndefined();
    expect(result.sectionFilter).toBeUndefined();
    expect(result.maxChars).toBeUndefined();
    expect(result.initHook).toBe(false);
  });

  it("parses boolean flags", () => {
    const result = parseCliArgs(["--yes", "--dry-run", "--verbose", "--ci"]);
    expect(result.yes).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.verbose).toBe(true);
    expect(result.ciMode).toBe(true);
  });

  it("parses -v as verbose", () => {
    expect(parseCliArgs(["-v"]).verbose).toBe(true);
  });

  it("parses --check", () => {
    const result = parseCliArgs(["--check"]);
    expect(result.check).toBe(true);
    expect(result.checkTimestamp).toBe(false);
  });

  it("parses --check=timestamp", () => {
    const result = parseCliArgs(["--check=timestamp"]);
    expect(result.check).toBe(true);
    expect(result.checkTimestamp).toBe(true);
  });

  it("parses --max-tokens=N", () => {
    const result = parseCliArgs(["--max-tokens=5000"]);
    expect(result.maxTokens).toBe(5000);
  });

  it("throws ClarteError on invalid --max-tokens", () => {
    expect(() => parseCliArgs(["--max-tokens=abc"])).toThrow(ClarteError);
  });

  it("parses --budget=N", () => {
    const result = parseCliArgs(["--budget=3000"]);
    expect(result.effectiveBudget).toBe(3000);
  });

  it("throws ClarteError on invalid --budget", () => {
    expect(() => parseCliArgs(["--budget=xyz"])).toThrow(ClarteError);
  });

  it("parses --full as budget=0", () => {
    const result = parseCliArgs(["--full"]);
    expect(result.effectiveBudget).toBe(0);
  });

  it("parses --format=json", () => {
    expect(parseCliArgs(["--format=json"]).jsonMode).toBe(true);
    expect(parseCliArgs(["--format=text"]).jsonMode).toBe(false);
  });

  it("parses --include and --exclude", () => {
    const result = parseCliArgs(["--include=snapshot,conventions", "--exclude=dead-files"]);
    expect(result.sectionFilter?.include).toEqual(new Set(["snapshot", "conventions"]));
    expect(result.sectionFilter?.exclude).toEqual(new Set(["dead-files"]));
  });

  it("parses --max-chars=N", () => {
    const result = parseCliArgs(["--max-chars=20000"]);
    expect(result.maxChars).toBe(20000);
  });

  it("throws ClarteError on invalid --max-chars", () => {
    expect(() => parseCliArgs(["--max-chars=bad"])).toThrow(ClarteError);
  });

  it("parses positional directory argument", () => {
    const result = parseCliArgs(["./my-project"]);
    expect(result.rootDir).toContain("my-project");
  });

  it("parses --init-hook", () => {
    expect(parseCliArgs(["--init-hook"]).initHook).toBe(true);
  });

  it("parses --refresh-snapshot", () => {
    expect(parseCliArgs(["--refresh-snapshot"]).refresh).toBe(true);
  });

  it("parses --reconfigure", () => {
    expect(parseCliArgs(["--reconfigure"]).reconfigure).toBe(true);
  });

  it("throws on --dry-run + --check conflict", () => {
    expect(() => parseCliArgs(["--dry-run", "--check"])).toThrow(ClarteError);
  });

  it("warns on unknown flags", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseCliArgs(["--unknown-flag"]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown flag: --unknown-flag"));
    warnSpy.mockRestore();
  });

  it("does not warn on known flags", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseCliArgs(["--yes", "--verbose", "--dry-run"]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
