import { describe, expect, it } from "vitest";
import { getDefaultScanPaths, getDefaultScanPathsForLanguage, getLanguageConfig } from "../core/snapshot/scan-paths.js";
import type { DetectedContext, Language } from "../core/types.js";

function makeCtx(language: Language, directories: string[]): DetectedContext {
  return {
    rootDir: "/test",
    language,
    directories,
    sourceFileCount: 100,
    frameworks: [],
    topLevelEntries: [],
    isGitRepo: false,
    configConstraints: [],
    tooling: {},
  } as unknown as DetectedContext;
}

describe("getDefaultScanPaths", () => {
  describe("typescript/javascript", () => {
    it("returns type directories first", () => {
      const ctx = makeCtx("typescript", ["src/types", "src/components", "src/hooks"]);
      const paths = getDefaultScanPaths(ctx);
      expect(paths[0]).toBe("src/types");
    });

    it("includes stores, services, hooks, components, lib in order", () => {
      const ctx = makeCtx("typescript", [
        "src/lib",
        "src/hooks",
        "src/components",
        "src/services",
        "src/stores",
        "src/types",
      ]);
      const paths = getDefaultScanPaths(ctx);
      expect(paths).toEqual(["src/types", "src/stores", "src/services", "src/hooks", "src/components", "src/lib"]);
    });

    it("falls back to src/app/lib when no matching dirs", () => {
      const ctx = makeCtx("typescript", ["docs", "scripts"]);
      expect(getDefaultScanPaths(ctx)).toEqual(["src", "app", "lib"]);
    });

    it("matches typings directory", () => {
      const ctx = makeCtx("javascript", ["src/typings"]);
      expect(getDefaultScanPaths(ctx)).toContain("src/typings");
    });

    it("matches store (singular)", () => {
      const ctx = makeCtx("typescript", ["src/store"]);
      expect(getDefaultScanPaths(ctx)).toContain("src/store");
    });

    it("matches api directory", () => {
      const ctx = makeCtx("typescript", ["src/api"]);
      expect(getDefaultScanPaths(ctx)).toContain("src/api");
    });

    it("matches utils directory", () => {
      const ctx = makeCtx("typescript", ["src/utils"]);
      expect(getDefaultScanPaths(ctx)).toContain("src/utils");
    });
  });

  describe("python", () => {
    it("matches python-specific directories", () => {
      const ctx = makeCtx("python", ["app/models", "app/schemas", "app/routes", "app/db"]);
      const paths = getDefaultScanPaths(ctx);
      expect(paths).toContain("app/models");
      expect(paths).toContain("app/schemas");
      expect(paths).toContain("app/routes");
      expect(paths).toContain("app/db");
    });

    it("falls back to src/app/lib/. when no matching dirs", () => {
      const ctx = makeCtx("python", ["docs", "scripts"]);
      expect(getDefaultScanPaths(ctx)).toEqual(["src", "app", "lib", "."]);
    });

    it("matches routers and views", () => {
      const ctx = makeCtx("python", ["app/routers", "app/views"]);
      expect(getDefaultScanPaths(ctx)).toContain("app/routers");
      expect(getDefaultScanPaths(ctx)).toContain("app/views");
    });
  });

  describe("go", () => {
    it("matches go-specific directories", () => {
      const ctx = makeCtx("go", ["internal", "pkg", "cmd", "handlers"]);
      const paths = getDefaultScanPaths(ctx);
      expect(paths).toContain("internal");
      expect(paths).toContain("pkg");
      expect(paths).toContain("cmd");
      expect(paths).toContain("handlers");
    });

    it("falls back to ./internal/pkg/cmd", () => {
      const ctx = makeCtx("go", ["docs"]);
      expect(getDefaultScanPaths(ctx)).toEqual([".", "internal", "pkg", "cmd"]);
    });

    it("matches domain and repository directories", () => {
      const ctx = makeCtx("go", ["domain", "repository"]);
      expect(getDefaultScanPaths(ctx)).toContain("domain");
      expect(getDefaultScanPaths(ctx)).toContain("repository");
    });
  });

  describe("rust", () => {
    it("matches rust-specific directories", () => {
      const ctx = makeCtx("rust", ["src", "src/models", "src/handlers"]);
      const paths = getDefaultScanPaths(ctx);
      expect(paths).toContain("src");
      expect(paths).toContain("src/models");
      expect(paths).toContain("src/handlers");
    });

    it("falls back to src", () => {
      const ctx = makeCtx("rust", ["docs"]);
      expect(getDefaultScanPaths(ctx)).toEqual(["src"]);
    });
  });

  describe("java", () => {
    it("matches java-specific directories", () => {
      const ctx = makeCtx("java", [
        "src/main/java/com/example/controllers",
        "src/main/java/com/example/services",
        "src/main/java/com/example/entities",
      ]);
      const paths = getDefaultScanPaths(ctx);
      expect(paths).toContain("src/main/java/com/example/controllers");
      expect(paths).toContain("src/main/java/com/example/services");
      expect(paths).toContain("src/main/java/com/example/entities");
    });

    it("adds src/main/java when src dir exists", () => {
      const ctx = makeCtx("java", ["src"]);
      expect(getDefaultScanPaths(ctx)).toContain("src/main/java");
    });

    it("falls back to src/main/java and src", () => {
      const ctx = makeCtx("java", ["docs"]);
      expect(getDefaultScanPaths(ctx)).toEqual(["src/main/java", "src"]);
    });

    it("matches dto and domain directories", () => {
      const ctx = makeCtx("java", ["src/main/java/dto", "src/main/java/domain"]);
      const paths = getDefaultScanPaths(ctx);
      expect(paths).toContain("src/main/java/dto");
      expect(paths).toContain("src/main/java/domain");
    });
  });
});

describe("getDefaultScanPathsForLanguage", () => {
  it("dispatches to the correct language handler", () => {
    const ctx = makeCtx("typescript", ["src/types"]);
    const tsPaths = getDefaultScanPathsForLanguage("typescript", ctx);
    expect(tsPaths).toContain("src/types");

    // Python handler also matches "types" in its keyword list
    const pyPaths = getDefaultScanPathsForLanguage("python", ctx);
    expect(pyPaths).toContain("src/types");

    // With no matching dirs, python falls back to defaults
    const ctx2 = makeCtx("python", ["docs"]);
    const pyFallback = getDefaultScanPathsForLanguage("python", ctx2);
    expect(pyFallback).toEqual(["src", "app", "lib", "."]);
  });
});

describe("getLanguageConfig", () => {
  it("returns correct glob for python", () => {
    const config = getLanguageConfig("python");
    expect(config.glob).toBe("**/*.py");
    expect(config.ignore).toContain("**/__pycache__/**");
    expect(config.ignore).toContain("**/venv/**");
  });

  it("returns correct glob for go", () => {
    const config = getLanguageConfig("go");
    expect(config.glob).toBe("**/*.go");
    expect(config.ignore).toContain("**/*_test.go");
  });

  it("returns correct glob for rust", () => {
    const config = getLanguageConfig("rust");
    expect(config.glob).toBe("**/*.rs");
    expect(config.ignore).toContain("**/target/**");
  });

  it("returns correct glob for java", () => {
    const config = getLanguageConfig("java");
    expect(config.glob).toBe("**/*.java");
    expect(config.ignore).toContain("**/*Test.java");
    expect(config.ignore).toContain("**/*Spec.java");
  });

  it("returns ts/js glob for typescript", () => {
    const config = getLanguageConfig("typescript");
    expect(config.glob).toBe("**/*.{ts,tsx,js,jsx}");
    expect(config.ignore).toEqual([]);
  });

  it("provides a working extractor function", () => {
    const config = getLanguageConfig("python");
    expect(typeof config.extractor).toBe("function");
  });
});
