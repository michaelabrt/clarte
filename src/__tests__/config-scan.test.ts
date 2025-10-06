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

describe("scanConfigConstraints -- Go", () => {
  it("extracts Go version from go.mod", async () => {
    mockReadFileOr.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("go.mod")) {
        return "module example.com/myapp\n\ngo 1.21\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n)\n";
      }
      return null;
    });

    const ctx = makeCtx({ language: "go", hasTypeScript: false });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.go).toBeDefined();
    expect(result.go!.version).toBe("1.21");
  });

  it("extracts Go version with patch (e.g. 1.21.3)", async () => {
    mockReadFileOr.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("go.mod")) {
        return "module example.com/myapp\n\ngo 1.21.3\n";
      }
      return null;
    });

    const ctx = makeCtx({ language: "go", hasTypeScript: false });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.go).toBeDefined();
    expect(result.go!.version).toBe("1.21.3");
  });

  it("returns undefined go when go.mod is missing", async () => {
    mockReadFileOr.mockResolvedValue(null);
    const ctx = makeCtx({ language: "go", hasTypeScript: false });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.go).toBeUndefined();
  });
});

describe("scanConfigConstraints -- Rust", () => {
  it("extracts Rust edition from Cargo.toml", async () => {
    mockReadFileOr.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("Cargo.toml")) {
        return '[package]\nname = "myapp"\nversion = "0.1.0"\nedition = "2021"\n';
      }
      return null;
    });

    const ctx = makeCtx({ language: "rust", hasTypeScript: false });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.rust).toBeDefined();
    expect(result.rust!.edition).toBe("2021");
    expect(result.rust!.clippy).toBeUndefined();
  });

  it("extracts clippy deny rules from Cargo.toml", async () => {
    mockReadFileOr.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("Cargo.toml")) {
        return [
          '[package]',
          'name = "myapp"',
          'version = "0.1.0"',
          'edition = "2021"',
          '',
          '[lints.clippy]',
          'pedantic = "deny"',
          'complexity = "deny"',
          'style = "warn"',
        ].join("\n");
      }
      return null;
    });

    const ctx = makeCtx({ language: "rust", hasTypeScript: false });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.rust).toBeDefined();
    expect(result.rust!.clippy).toEqual(["pedantic", "complexity"]);
  });

  it("returns undefined rust when Cargo.toml is missing", async () => {
    mockReadFileOr.mockResolvedValue(null);
    const ctx = makeCtx({ language: "rust", hasTypeScript: false });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.rust).toBeUndefined();
  });
});

describe("scanConfigConstraints -- Python", () => {
  it("extracts requires-python version from pyproject.toml", async () => {
    mockReadFileOr.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("pyproject.toml")) {
        return [
          '[project]',
          'name = "myapp"',
          'requires-python = ">=3.9"',
        ].join("\n");
      }
      return null;
    });

    const ctx = makeCtx({ language: "python", hasTypeScript: false });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.python).toBeDefined();
    expect(result.python!.version).toBe(">=3.9");
  });

  it("extracts ruff rule selections", async () => {
    mockReadFileOr.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("pyproject.toml")) {
        return [
          '[project]',
          'name = "myapp"',
          'requires-python = ">=3.9"',
          '',
          '[tool.ruff.lint]',
          'select = ["E", "F", "W", "I"]',
        ].join("\n");
      }
      return null;
    });

    const ctx = makeCtx({ language: "python", hasTypeScript: false });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.python).toBeDefined();
    expect(result.python!.ruff).toEqual(["E", "F", "W", "I"]);
  });

  it("extracts ruff rules from [tool.ruff] (without .lint suffix)", async () => {
    mockReadFileOr.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("pyproject.toml")) {
        return [
          '[project]',
          'name = "myapp"',
          '',
          '[tool.ruff]',
          'select = ["E", "F"]',
        ].join("\n");
      }
      return null;
    });

    const ctx = makeCtx({ language: "python", hasTypeScript: false });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.python).toBeDefined();
    expect(result.python!.ruff).toEqual(["E", "F"]);
  });

  it("extracts mypy strict mode", async () => {
    mockReadFileOr.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("pyproject.toml")) {
        return [
          '[project]',
          'name = "myapp"',
          '',
          '[tool.mypy]',
          'strict = true',
        ].join("\n");
      }
      return null;
    });

    const ctx = makeCtx({ language: "python", hasTypeScript: false });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.python).toBeDefined();
    expect(result.python!.mypy).toEqual({ strict: true });
  });

  it("returns undefined python when pyproject.toml is missing", async () => {
    mockReadFileOr.mockResolvedValue(null);
    const ctx = makeCtx({ language: "python", hasTypeScript: false });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.python).toBeUndefined();
  });

  it("returns undefined python when pyproject.toml has no relevant sections", async () => {
    mockReadFileOr.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("pyproject.toml")) {
        return '[build-system]\nrequires = ["setuptools"]\n';
      }
      return null;
    });

    const ctx = makeCtx({ language: "python", hasTypeScript: false });
    const result = await scanConfigConstraints("/test", ctx);

    expect(result.python).toBeUndefined();
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

  it("renders Go constraints", () => {
    const constraints: ConfigConstraints = {
      go: { version: "1.21" },
    };

    const result = renderConstraintsSection(constraints);
    expect(result).toContain("## Config Constraints");
    expect(result).toContain("**Must**: Target Go 1.21 or later.");
  });

  it("renders Rust constraints with clippy rules", () => {
    const constraints: ConfigConstraints = {
      rust: { edition: "2021", clippy: ["pedantic", "complexity"] },
    };

    const result = renderConstraintsSection(constraints);
    expect(result).toContain("**Must**: Use Rust edition 2021.");
    expect(result).toContain("**Prefer**: Follow clippy::pedantic lint rules.");
    expect(result).toContain("**Prefer**: Follow clippy::complexity lint rules.");
  });

  it("renders Rust constraints without clippy rules", () => {
    const constraints: ConfigConstraints = {
      rust: { edition: "2021" },
    };

    const result = renderConstraintsSection(constraints);
    expect(result).toContain("**Must**: Use Rust edition 2021.");
    expect(result).not.toContain("clippy");
  });

  it("renders Python constraints with all fields", () => {
    const constraints: ConfigConstraints = {
      python: {
        version: ">=3.9",
        ruff: ["E", "F", "W"],
        mypy: { strict: true },
      },
    };

    const result = renderConstraintsSection(constraints);
    expect(result).toContain("**Must**: Support Python >=3.9.");
    expect(result).toContain("**Must**: mypy strict mode enabled.");
    expect(result).toContain("**Prefer**: Follow ruff rule selections: E, F, W.");
  });

  it("renders Python constraints with only version", () => {
    const constraints: ConfigConstraints = {
      python: { version: ">=3.9" },
    };

    const result = renderConstraintsSection(constraints);
    expect(result).toContain("**Must**: Support Python >=3.9.");
    expect(result).not.toContain("mypy");
    expect(result).not.toContain("ruff");
  });
});
