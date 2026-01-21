import { describe, it, expect } from "vitest";
import {
  extractMentionedFiles,
  assignScope,
  groupDirectivesByScope,
  buildFileDirectiveMap,
} from "../templates/directive-scope.js";

describe("extractMentionedFiles", () => {
  it("extracts backtick-quoted file paths with extensions", () => {
    const directive = "When modifying `src/utils.ts` (Foundation), check dependents.";
    expect(extractMentionedFiles(directive)).toEqual(["src/utils.ts"]);
  });

  it("extracts multiple file paths", () => {
    const directive = "When modifying `src/a.ts`, also check `src/b.ts` (60% of the time).";
    expect(extractMentionedFiles(directive)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("ignores backtick strings without path separators", () => {
    const directive = "Use `npm` for package management.";
    expect(extractMentionedFiles(directive)).toEqual([]);
  });

  it("ignores backtick strings without extensions", () => {
    const directive = "Check `src/core` before modifying.";
    expect(extractMentionedFiles(directive)).toEqual([]);
  });

  it("returns empty for directives with no backticks", () => {
    expect(extractMentionedFiles("No file references here.")).toEqual([]);
  });

  it("handles extensions up to 5 characters", () => {
    const directive = "Check `src/config.jsonc` for settings.";
    expect(extractMentionedFiles(directive)).toEqual(["src/config.jsonc"]);
  });
});

describe("assignScope", () => {
  it("returns second-level dir under src/", () => {
    expect(assignScope(["src/core/run-analysis.ts", "src/core/phase-logger.ts"])).toBe("src/core");
  });

  it("returns first-level dir for non-src paths", () => {
    expect(assignScope(["action/src/comment.ts"])).toBe("action");
  });

  it("returns null for empty file list", () => {
    expect(assignScope([])).toBeNull();
  });

  it("returns null when files span 3+ directories", () => {
    expect(assignScope(["src/core/a.ts", "src/graph/b.ts", "src/hooks/c.ts"])).toBeNull();
  });

  it("returns scope when files span exactly 2 directories", () => {
    const scope = assignScope(["src/core/a.ts", "src/graph/b.ts"]);
    expect(scope).toBe("src/core"); // alphabetically first
  });

  it("scopes files directly in src/ to first-level dir", () => {
    // src/index.ts has 2 parts, so it falls into the first-level branch
    expect(assignScope(["src/index.ts"])).toBe("src");
  });
});

describe("groupDirectivesByScope", () => {
  it("groups directives by directory", () => {
    const directives = [
      "When modifying `src/core/a.ts`, check `src/core/b.ts`.",
      "When modifying `src/graph/c.ts`, check things.",
      "Layer violation: 3 imports flow upward.",
    ];

    const groups = groupDirectivesByScope(directives);
    expect(groups.get("src/core")).toHaveLength(1);
    expect(groups.get("src/graph")).toHaveLength(1);
    expect(groups.get(null)).toHaveLength(1);
  });

  it("puts multi-directory directives as global when 3+ dirs", () => {
    const directives = ["When modifying `src/core/a.ts`, check `src/graph/b.ts` and `src/hooks/c.ts`."];

    const groups = groupDirectivesByScope(directives);
    expect(groups.get(null)).toHaveLength(1);
    expect(groups.has("src/core")).toBe(false);
  });

  it("returns empty map for empty input", () => {
    expect(groupDirectivesByScope([]).size).toBe(0);
  });
});

describe("buildFileDirectiveMap", () => {
  it("maps each mentioned file to its directives", () => {
    const directives = ["When modifying `src/a.ts`, check `src/b.ts`.", "When modifying `src/b.ts`, check `src/c.ts`."];

    const map = buildFileDirectiveMap(directives);
    expect(map.get("src/a.ts")).toEqual([directives[0]]);
    expect(map.get("src/b.ts")).toEqual([directives[0], directives[1]]);
    expect(map.get("src/c.ts")).toEqual([directives[1]]);
  });

  it("returns empty map for directives with no file references", () => {
    const map = buildFileDirectiveMap(["No files mentioned."]);
    expect(map.size).toBe(0);
  });
});
