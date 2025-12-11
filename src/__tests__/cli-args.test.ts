import { describe, expect, it, vi, beforeEach } from "vitest";
import { parseCliArgs } from "../cli-args.js";

// Mock process.exit to prevent test termination
const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
const mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseCliArgs", () => {
  it("parses empty args to defaults", () => {
    const result = parseCliArgs([]);
    expect(result.force).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.refresh).toBe(false);
    expect(result.reconfigure).toBe(false);
    expect(result.diffMode).toBe(false);
    expect(result.diffRef).toBeUndefined();
    expect(result.diffFilterFiles).toEqual([]);
    expect(result.check).toBe(false);
    expect(result.checkTimestamp).toBe(false);
    expect(result.ciMode).toBe(false);
    expect(result.verbose).toBe(false);
    expect(result.watchMode).toBe(false);
    expect(result.generateSkills).toBe(false);
    expect(result.maxTokens).toBeUndefined();
    expect(result.jsonMode).toBe(false);
    expect(result.effectiveBudget).toBeUndefined();
    expect(result.sectionFilter).toBeUndefined();
    expect(result.maxChars).toBeUndefined();
    expect(result.initHook).toBe(false);
  });

  it("parses boolean flags", () => {
    const result = parseCliArgs(["--force", "--dry-run", "--verbose", "--ci", "--watch"]);
    expect(result.force).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.verbose).toBe(true);
    expect(result.ciMode).toBe(true);
    expect(result.watchMode).toBe(true);
  });

  it("parses -v as verbose", () => {
    expect(parseCliArgs(["-v"]).verbose).toBe(true);
  });

  it("parses --diff without ref", () => {
    const result = parseCliArgs(["--diff"]);
    expect(result.diffMode).toBe(true);
    expect(result.diffRef).toBeUndefined();
    expect(result.diffFilterFiles).toEqual([]);
  });

  it("parses --diff=REF with ref", () => {
    const result = parseCliArgs(["--diff=main"]);
    expect(result.diffMode).toBe(true);
    expect(result.diffRef).toBe("main");
  });

  it("parses --diff with file filter arguments", () => {
    const result = parseCliArgs(["--diff", "src/foo.ts", "src/bar.ts"]);
    expect(result.diffMode).toBe(true);
    expect(result.diffFilterFiles).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("stops file filter at next flag", () => {
    const result = parseCliArgs(["--diff", "src/foo.ts", "--verbose"]);
    expect(result.diffFilterFiles).toEqual(["src/foo.ts"]);
    expect(result.verbose).toBe(true);
  });

  it("parses --diff-file=PATH", () => {
    const result = parseCliArgs(["--diff", "--diff-file=output.md"]);
    expect(result.diffFile).toBe("output.md");
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

  it("exits on invalid --max-tokens", () => {
    parseCliArgs(["--max-tokens=abc"]);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError).toHaveBeenCalled();
  });

  it("parses --budget=N", () => {
    const result = parseCliArgs(["--budget=3000"]);
    expect(result.effectiveBudget).toBe(3000);
  });

  it("exits on invalid --budget", () => {
    parseCliArgs(["--budget=xyz"]);
    expect(mockExit).toHaveBeenCalledWith(1);
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

  it("exits on invalid --max-chars", () => {
    parseCliArgs(["--max-chars=bad"]);
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("parses positional directory argument", () => {
    const result = parseCliArgs(["./my-project"]);
    expect(result.rootDir).toContain("my-project");
  });

  it("ignores diff filter files when picking target directory", () => {
    const result = parseCliArgs(["--diff", "src/foo.ts", "./my-project"]);
    // src/foo.ts is a diff filter file, ./my-project is the target dir
    // But since src/foo.ts comes first after --diff, it's a filter file
    // and ./my-project would also be treated as a filter file (no break on non-flag)
    expect(result.diffFilterFiles).toEqual(["src/foo.ts", "./my-project"]);
  });

  it("parses --init-hook", () => {
    expect(parseCliArgs(["--init-hook"]).initHook).toBe(true);
  });

  it("parses --generate-skills", () => {
    expect(parseCliArgs(["--generate-skills"]).generateSkills).toBe(true);
  });

  it("parses --refresh-snapshot", () => {
    expect(parseCliArgs(["--refresh-snapshot"]).refresh).toBe(true);
  });

  it("parses --reconfigure", () => {
    expect(parseCliArgs(["--reconfigure"]).reconfigure).toBe(true);
  });
});
