import { describe, expect, it, vi, beforeEach } from "vitest";
import { scanConfigConstraints, renderConstraintsSection } from "../config-scan.js";
import type { ConfigConstraints, DetectedContext } from "../types.js";

// Mock utils.ts to control file reads
vi.mock("../utils.js", () => ({
  readFileOr: vi.fn().mockResolvedValue(null),
  readJsonFile: vi.fn().mockResolvedValue(null),
}));

import { readJsonFile, readFileOr } from "../utils.js";

const mockReadJsonFile = vi.mocked(readJsonFile);
const mockReadFileOr = vi.mocked(readFileOr);

function makeCtx(overrides: Partial<DetectedContext> = {}): DetectedContext {
  return {
    rootDir: "/test",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "none",
    frameworks: [],
    directories: [],
    dependencies: [],
    isGitRepo: false,
    totalSourceBytes: 0,
    sourceFileCount: 0,
    monorepo: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scanConfigConstraints — tsconfig", () => {
  it("detects strict mode", async () => {
    mockReadJsonFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("tsconfig.json")) {
        return { compilerOptions: { strict: true, target: "ES2022" } };
      }
      return null;
    });

    const result = await scanConfigConstraints("/test", makeCtx());
    expect(result.typescript).toBeDefined();
    expect(result.typescript!.strict).toBe(true);
    expect(result.typescript!.target).toBe("ES2022");
  });

  it("detects extra strict options beyond strict:true", async () => {
    mockReadJsonFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("tsconfig.json")) {
        return {
          compilerOptions: {
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
          },
        };
      }
      return null;
    });

    const result = await scanConfigConstraints("/test", makeCtx());
    expect(result.typescript!.otherStrict).toContain("exactOptionalPropertyTypes");
    expect(result.typescript!.otherStrict).toContain("noUncheckedIndexedAccess");
  });

  it("follows extends chain (child wins)", async () => {
    mockReadJsonFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("tsconfig.json")) {
        return {
          extends: "./tsconfig.base.json",
          compilerOptions: { target: "ES2022" },
        };
      }
      if (filePath.endsWith("tsconfig.base.json")) {
        return {
          compilerOptions: { strict: true, target: "ES2020" },
        };
      }
      return null;
    });

    const result = await scanConfigConstraints("/test", makeCtx());
    // Child's target wins
    expect(result.typescript!.target).toBe("ES2022");
    // Parent's strict is inherited
    expect(result.typescript!.strict).toBe(true);
  });

  it("extracts path aliases", async () => {
    mockReadJsonFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("tsconfig.json")) {
        return {
          compilerOptions: {
            paths: { "@/*": ["src/*"], "@utils/*": ["src/utils/*"] },
          },
        };
      }
      return null;
    });

    const result = await scanConfigConstraints("/test", makeCtx());
    expect(result.typescript!.pathAliases).toEqual({
      "@/*": ["src/*"],
      "@utils/*": ["src/utils/*"],
    });
  });
});

describe("scanConfigConstraints — ESLint", () => {
  it("extracts impactful rules from .eslintrc.json", async () => {
    mockReadJsonFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("tsconfig.json")) return null;
      if (filePath.endsWith(".eslintrc.json")) {
        return {
          rules: {
            "prefer-const": "error",
            "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
            "no-console": "warn",
            "some-other-rule": "error",
          },
        };
      }
      return null;
    });

    const ctx = makeCtx({ linter: "eslint", language: "typescript" });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.linter).toBeDefined();
    expect(result.linter!.tool).toBe("ESLint");
    expect(result.linter!.keyRules).toHaveLength(3);
    expect(result.linter!.keyRules.map((r) => r.rule)).toContain("prefer-const");
    expect(result.linter!.keyRules.map((r) => r.rule)).toContain("@typescript-eslint/consistent-type-imports");
    expect(result.linter!.keyRules.map((r) => r.rule)).toContain("no-console");
  });

  it("falls back to eslintConfig in package.json", async () => {
    mockReadJsonFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("tsconfig.json")) return null;
      if (filePath.endsWith(".eslintrc.json") || filePath.endsWith(".eslintrc")) return null;
      if (filePath.endsWith("package.json")) {
        return {
          eslintConfig: {
            rules: { eqeqeq: "error" },
          },
        };
      }
      return null;
    });

    const ctx = makeCtx({ linter: "eslint", language: "typescript" });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.linter).toBeDefined();
    expect(result.linter!.keyRules.map((r) => r.rule)).toContain("eqeqeq");
  });

  it("skips rules set to off", async () => {
    mockReadJsonFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("tsconfig.json")) return null;
      if (filePath.endsWith(".eslintrc.json")) {
        return {
          rules: {
            "prefer-const": "off",
            "no-console": 0,
            eqeqeq: "error",
          },
        };
      }
      return null;
    });

    const ctx = makeCtx({ linter: "eslint", language: "typescript" });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.linter!.keyRules).toHaveLength(1);
    expect(result.linter!.keyRules[0].rule).toBe("eqeqeq");
  });
});

describe("scanConfigConstraints — Biome", () => {
  it("extracts linter rules from biome.json", async () => {
    mockReadJsonFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("tsconfig.json")) return null;
      if (filePath.endsWith("biome.json")) {
        return {
          linter: {
            rules: {
              style: {
                useConst: "error",
                useImportType: "warn",
              },
              suspicious: {
                noExplicitAny: "error",
              },
            },
          },
        };
      }
      return null;
    });

    const ctx = makeCtx({ linter: "biome", language: "typescript" });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.linter).toBeDefined();
    expect(result.linter!.tool).toBe("Biome");
    expect(result.linter!.keyRules).toHaveLength(3);
  });

  it("extracts formatter settings from biome.json", async () => {
    mockReadJsonFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("tsconfig.json")) return null;
      if (filePath.endsWith("biome.json")) {
        return {
          formatter: {
            indentStyle: "space",
            indentWidth: 2,
          },
          javascript: {
            formatter: {
              quoteStyle: "single",
              semicolons: "asNeeded",
            },
          },
        };
      }
      return null;
    });

    const ctx = makeCtx({ linter: "biome", language: "typescript" });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.formatter).toBeDefined();
    expect(result.formatter!.tool).toBe("Biome");
    expect(result.formatter!.indent).toBe("2-space");
    expect(result.formatter!.quotes).toBe("single");
    expect(result.formatter!.semicolons).toBe(false);
  });
});

describe("scanConfigConstraints — Prettier", () => {
  it("extracts settings from .prettierrc", async () => {
    mockReadJsonFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("tsconfig.json")) return null;
      if (filePath.endsWith(".prettierrc")) {
        return {
          tabWidth: 2,
          singleQuote: true,
          semi: false,
          trailingComma: "all",
        };
      }
      return null;
    });

    const ctx = makeCtx({
      linter: "prettier",
      language: "typescript",
      dependencies: ["prettier"],
    });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.formatter).toBeDefined();
    expect(result.formatter!.tool).toBe("Prettier");
    expect(result.formatter!.indent).toBe("2-space");
    expect(result.formatter!.quotes).toBe("single");
    expect(result.formatter!.semicolons).toBe(false);
  });

  it("falls back to prettier field in package.json", async () => {
    mockReadJsonFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("tsconfig.json")) return null;
      if (filePath.endsWith(".prettierrc") || filePath.endsWith(".prettierrc.json")) return null;
      if (filePath.endsWith("package.json")) {
        return {
          prettier: {
            useTabs: true,
            singleQuote: false,
            semi: true,
          },
        };
      }
      return null;
    });

    const ctx = makeCtx({
      linter: "prettier",
      language: "typescript",
      dependencies: ["prettier"],
    });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.formatter).toBeDefined();
    expect(result.formatter!.indent).toBe("tabs");
    expect(result.formatter!.quotes).toBe("double");
    expect(result.formatter!.semicolons).toBe(true);
  });
});

describe("renderConstraintsSection", () => {
  it("renders TypeScript strict mode", () => {
    const constraints: ConfigConstraints = {
      typescript: {
        strict: true,
        target: "ES2022",
        pathAliases: {},
        otherStrict: ["exactOptionalPropertyTypes"],
      },
    };

    const result = renderConstraintsSection(constraints);
    expect(result).toContain("## Config Constraints");
    expect(result).toContain("TypeScript strict mode");
    expect(result).toContain("exactOptionalPropertyTypes");
    expect(result).toContain("ES2022");
  });

  it("renders linter rules with correct prefix", () => {
    const constraints: ConfigConstraints = {
      linter: {
        tool: "ESLint",
        keyRules: [
          { rule: "prefer-const", setting: "error", impact: "use const for variables that are never reassigned" },
          { rule: "no-console", setting: "warn", impact: "no console.log in production code" },
        ],
      },
    };

    const result = renderConstraintsSection(constraints);
    expect(result).toContain("**Must**: use const");
    expect(result).toContain("**Prefer**: no console.log");
  });

  it("renders formatter settings", () => {
    const constraints: ConfigConstraints = {
      formatter: {
        tool: "Prettier",
        indent: "2-space",
        quotes: "single",
        semicolons: true,
      },
    };

    const result = renderConstraintsSection(constraints);
    expect(result).toContain("2-space");
    expect(result).toContain("single quotes");
    expect(result).toContain("semicolons");
    expect(result).toContain("Prettier");
  });

  it("returns null when no constraints", () => {
    const result = renderConstraintsSection({});
    expect(result).toBeNull();
  });
});
