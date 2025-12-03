import path from "node:path";
import { readFileOr, readJsonFile } from "./utils.js";
import type { ConfigConstraints, DetectedContext } from "./types.js";

// ── Impactful linter rules to extract ─────────────────────────────────

/** ESLint rule name -> Biome equivalent */
const IMPACTFUL_RULES: Array<{
  eslint: string;
  biome: string;
  impact: string;
}> = [
  { eslint: "prefer-const", biome: "style.useConst", impact: "use const for variables that are never reassigned" },
  {
    eslint: "@typescript-eslint/consistent-type-imports",
    biome: "style.useImportType",
    impact: "use type-only imports for types",
  },
  {
    eslint: "@typescript-eslint/no-explicit-any",
    biome: "suspicious.noExplicitAny",
    impact: "avoid explicit any types",
  },
  { eslint: "import/order", biome: "nursery.useSortedImports", impact: "keep imports sorted" },
  {
    eslint: "@typescript-eslint/no-unused-vars",
    biome: "correctness.noUnusedVariables",
    impact: "no unused variables",
  },
  { eslint: "no-console", biome: "suspicious.noConsole", impact: "no console.log in production code" },
  { eslint: "eqeqeq", biome: "suspicious.noDoubleEquals", impact: "use strict equality (===)" },
  { eslint: "@typescript-eslint/naming-convention", biome: "", impact: "enforce naming conventions" },
  { eslint: "@typescript-eslint/no-floating-promises", biome: "", impact: "handle all promises (no fire-and-forget)" },
  { eslint: "react/jsx-no-leaked-render", biome: "", impact: "avoid leaked renders in JSX (use ternary, not &&)" },
];

// ── TypeScript strict options that impact code generation ─────────────

const TS_STRICT_OPTIONS = [
  "noImplicitAny",
  "exactOptionalPropertyTypes",
  "noUncheckedIndexedAccess",
  "noPropertyAccessFromIndexSignature",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "noImplicitThis",
  "useUnknownInCatchVariables",
  "alwaysStrict",
] as const;

// ── Public API ────────────────────────────────────────────────────────

/**
 * Scan project config files (tsconfig, ESLint, Biome, Prettier) and extract
 * constraints that affect how an LLM should generate code.
 */
export async function scanConfigConstraints(rootDir: string, ctx: DetectedContext): Promise<ConfigConstraints> {
  const constraints: ConfigConstraints = {};

  // TypeScript config
  if (ctx.language === "typescript" || ctx.hasTypeScript) {
    constraints.typescript = await scanTsConfig(rootDir);
  }

  // Linter config
  if (ctx.linter === "eslint") {
    constraints.linter = await scanEslintConfig(rootDir);
  } else if (ctx.linter === "biome") {
    constraints.linter = await scanBiomeRules(rootDir);
  }

  // Formatter config
  if (ctx.linter === "biome") {
    const biomeFormatter = await scanBiomeFormatter(rootDir);
    if (biomeFormatter) constraints.formatter = biomeFormatter;
  }
  if (ctx.linter === "prettier" || ctx.dependencies.includes("prettier")) {
    const prettierFormatter = await scanPrettierConfig(rootDir);
    if (prettierFormatter) constraints.formatter = prettierFormatter;
  }

  // Go config
  if (ctx.language === "go") {
    const goConstraints = await scanGoConfig(rootDir);
    if (goConstraints) constraints.go = goConstraints;
  }

  // Rust config
  if (ctx.language === "rust") {
    const rustConstraints = await scanRustConfig(rootDir);
    if (rustConstraints) constraints.rust = rustConstraints;
  }

  // Python config
  if (ctx.language === "python") {
    const pythonConstraints = await scanPythonConfig(rootDir);
    if (pythonConstraints) constraints.python = pythonConstraints;
  }

  return constraints;
}

// ── tsconfig scanning ─────────────────────────────────────────────────

async function scanTsConfig(rootDir: string) {
  const result = {
    strict: false,
    target: "",
    pathAliases: {} as Record<string, string[]>,
    otherStrict: [] as string[],
  };

  // Walk extends chain (up to 5 levels), child wins
  const mergedOptions: Record<string, unknown> = {};
  let configPath = path.join(rootDir, "tsconfig.json");

  for (let depth = 0; depth < 5; depth++) {
    const config = await readJsonFile(configPath);
    if (!config) break;

    const co = config.compilerOptions as Record<string, unknown> | undefined;
    if (co) {
      // Child values set first take precedence (don't overwrite)
      for (const [key, value] of Object.entries(co)) {
        if (!(key in mergedOptions)) {
          mergedOptions[key] = value;
        }
      }
    }

    const ext = config.extends as string | undefined;
    if (!ext) break;

    configPath = path.resolve(path.dirname(configPath), ext);
    if (!configPath.endsWith(".json")) configPath += ".json";
  }

  // Extract key options
  result.strict = mergedOptions.strict === true;
  if (typeof mergedOptions.target === "string") {
    result.target = mergedOptions.target;
  }

  // Path aliases
  if (mergedOptions.paths && typeof mergedOptions.paths === "object") {
    result.pathAliases = mergedOptions.paths as Record<string, string[]>;
  }

  // Individual strict flags beyond `strict: true`
  for (const opt of TS_STRICT_OPTIONS) {
    if (mergedOptions[opt] === true && !result.strict) {
      result.otherStrict.push(opt);
    } else if (mergedOptions[opt] === true && result.strict) {
      // If strict is on, only note options that go *beyond* what strict enables
      if (
        opt === "exactOptionalPropertyTypes" ||
        opt === "noUncheckedIndexedAccess" ||
        opt === "noPropertyAccessFromIndexSignature"
      ) {
        result.otherStrict.push(opt);
      }
    }
  }

  return result;
}

// ── ESLint scanning ───────────────────────────────────────────────────

async function scanEslintConfig(rootDir: string) {
  let rules: Record<string, unknown> | null = null;

  // Try JSON configs (skip .js/.cjs — not reliably parseable)
  for (const filename of [".eslintrc.json", ".eslintrc"]) {
    const config = await readJsonFile(path.join(rootDir, filename));
    if (config?.rules && typeof config.rules === "object") {
      rules = config.rules as Record<string, unknown>;
      break;
    }
  }

  // Try eslintConfig in package.json
  if (!rules) {
    const pkg = await readJsonFile(path.join(rootDir, "package.json"));
    const eslintConfig = pkg?.eslintConfig as Record<string, unknown> | undefined;
    if (eslintConfig?.rules && typeof eslintConfig.rules === "object") {
      rules = eslintConfig.rules as Record<string, unknown>;
    }
  }

  if (!rules) return undefined;

  const keyRules: Array<{ rule: string; setting: string; impact: string }> = [];

  for (const def of IMPACTFUL_RULES) {
    if (!def.eslint) continue;
    const value = rules[def.eslint];
    if (value == null) continue;

    const setting = normalizeRuleSetting(value);
    if (setting === "off") continue;

    keyRules.push({ rule: def.eslint, setting, impact: def.impact });
  }

  if (keyRules.length === 0) return undefined;

  return { tool: "ESLint", keyRules };
}

// ── Biome scanning ────────────────────────────────────────────────────

async function scanBiomeRules(rootDir: string) {
  const config = await readBiomeConfig(rootDir);
  if (!config) return undefined;

  const linter = config.linter as Record<string, unknown> | undefined;
  const linterRules = linter?.rules as Record<string, unknown> | undefined;
  if (!linterRules) return undefined;

  const keyRules: Array<{ rule: string; setting: string; impact: string }> = [];

  for (const def of IMPACTFUL_RULES) {
    if (!def.biome) continue;

    // Biome rules are nested: e.g. "style.useConst" -> linter.rules.style.useConst
    const [category, ruleName] = def.biome.split(".");
    const categoryRules = linterRules[category] as Record<string, unknown> | undefined;
    if (!categoryRules) continue;

    const value = categoryRules[ruleName];
    if (value == null) continue;

    const setting = normalizeBiomeRuleSetting(value);
    if (setting === "off") continue;

    keyRules.push({ rule: def.biome, setting, impact: def.impact });
  }

  if (keyRules.length === 0) return undefined;

  return { tool: "Biome", keyRules };
}

async function scanBiomeFormatter(rootDir: string) {
  const config = await readBiomeConfig(rootDir);
  if (!config) return undefined;

  const formatter = config.formatter as Record<string, unknown> | undefined;
  const jsFormatter = (config.javascript as Record<string, unknown> | undefined)?.formatter as
    | Record<string, unknown>
    | undefined;

  if (!formatter && !jsFormatter) return undefined;

  const indentStyle = (formatter?.indentStyle as string) ?? "tab";
  const indentWidth = (formatter?.indentWidth as number) ?? 2;
  const indent = indentStyle === "tab" ? "tabs" : `${indentWidth}-space`;

  const quoteStyle = (jsFormatter?.quoteStyle as string) ?? "double";
  const quotes = quoteStyle === "single" ? "single" : "double";

  const semicolons = (jsFormatter?.semicolons as string) !== "asNeeded";

  return { tool: "Biome", indent, quotes, semicolons };
}

async function readBiomeConfig(rootDir: string): Promise<Record<string, unknown> | null> {
  // Try biome.json first, then biome.jsonc (strip comments)
  const biomeJson = await readJsonFile(path.join(rootDir, "biome.json"));
  if (biomeJson) return biomeJson;

  const biomeJsonc = await readFileOr(path.join(rootDir, "biome.jsonc"));
  if (biomeJsonc) {
    try {
      // Strip single-line comments and trailing commas for JSONC
      const cleaned = biomeJsonc.replace(/\/\/.*$/gm, "").replace(/,\s*([\]}])/g, "$1");
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }

  return null;
}

// ── Prettier scanning ─────────────────────────────────────────────────

async function scanPrettierConfig(rootDir: string) {
  let config: Record<string, unknown> | null = null;

  // Try .prettierrc / .prettierrc.json
  for (const filename of [".prettierrc", ".prettierrc.json"]) {
    config = await readJsonFile(path.join(rootDir, filename));
    if (config) break;
  }

  // Try prettier field in package.json
  if (!config) {
    const pkg = await readJsonFile(path.join(rootDir, "package.json"));
    if (pkg?.prettier && typeof pkg.prettier === "object") {
      config = pkg.prettier as Record<string, unknown>;
    }
  }

  if (!config) return undefined;

  const tabWidth = (config.tabWidth as number) ?? 2;
  const useTabs = (config.useTabs as boolean) ?? false;
  const indent = useTabs ? "tabs" : `${tabWidth}-space`;

  const singleQuote = (config.singleQuote as boolean) ?? false;
  const quotes = singleQuote ? "single" : "double";

  const semi = config.semi !== false;

  return { tool: "Prettier", indent, quotes, semicolons: semi };
}

// ── Go scanning ──────────────────────────────────────────────────────

async function scanGoConfig(rootDir: string): Promise<{ version: string } | undefined> {
  const goMod = await readFileOr(path.join(rootDir, "go.mod"));
  if (!goMod) return undefined;

  // Match "go 1.21" or "go 1.21.3" directive
  const match = goMod.match(/^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m);
  if (!match) return undefined;

  return { version: match[1] };
}

// ── Rust scanning ────────────────────────────────────────────────────

async function scanRustConfig(rootDir: string): Promise<{ edition: string; clippy?: string[] } | undefined> {
  const cargoToml = await readFileOr(path.join(rootDir, "Cargo.toml"));
  if (!cargoToml) return undefined;

  // Extract edition = "2021"
  const editionMatch = cargoToml.match(/^edition\s*=\s*"(\d{4})"/m);
  if (!editionMatch) return undefined;

  const result: { edition: string; clippy?: string[] } = {
    edition: editionMatch[1],
  };

  // Extract [lints.clippy] deny rules
  const clippySection = cargoToml.match(/\[lints\.clippy\]\s*\n([\s\S]*?)(?=\n\[|$)/);
  if (clippySection) {
    const denyRules: string[] = [];
    // Match lines like: pedantic = "deny" or complexity = "deny"
    const ruleRegex = /^(\w[\w-]*)\s*=\s*"deny"/gm;
    let ruleMatch: RegExpExecArray | null;
    while ((ruleMatch = ruleRegex.exec(clippySection[1])) !== null) {
      denyRules.push(ruleMatch[1]);
    }
    if (denyRules.length > 0) {
      result.clippy = denyRules;
    }
  }

  return result;
}

// ── Python scanning ──────────────────────────────────────────────────

async function scanPythonConfig(
  rootDir: string,
): Promise<{ version?: string; ruff?: string[]; mypy?: { strict: boolean } } | undefined> {
  const pyproject = await readFileOr(path.join(rootDir, "pyproject.toml"));
  if (!pyproject) return undefined;

  const result: { version?: string; ruff?: string[]; mypy?: { strict: boolean } } = {};
  let hasData = false;

  // Extract requires-python = ">=3.9"
  const versionMatch = pyproject.match(/requires-python\s*=\s*"([^"]+)"/);
  if (versionMatch) {
    result.version = versionMatch[1];
    hasData = true;
  }

  // Extract [tool.ruff] or [tool.ruff.lint] select rules
  // Use a lookahead for the next TOML section header (line starting with [) to capture the body
  const ruffSection = pyproject.match(/\[tool\.ruff(?:\.lint)?\]\s*\n([\s\S]*?)(?=\n\[|$)/);
  if (ruffSection) {
    const selectMatch = ruffSection[1].match(/select\s*=\s*\[([^\]]*)\]/);
    if (selectMatch) {
      const rules = selectMatch[1]
        .split(",")
        .map((r) => r.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      if (rules.length > 0) {
        result.ruff = rules;
        hasData = true;
      }
    }
  }

  // Extract [tool.mypy] strict mode
  const mypySection = pyproject.match(/\[tool\.mypy\]\s*\n([\s\S]*?)(?=\n\[|$)/);
  if (mypySection) {
    const strictMatch = mypySection[1].match(/strict\s*=\s*(true|false)/i);
    if (strictMatch) {
      result.mypy = { strict: strictMatch[1].toLowerCase() === "true" };
      hasData = true;
    }
  }

  return hasData ? result : undefined;
}

// ── Helpers ───────────────────────────────────────────────────────────

function normalizeRuleSetting(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const level = value[0];
    if (level === 0 || level === "off") return "off";
    if (level === 1 || level === "warn") return "warn";
    if (level === 2 || level === "error") return "error";
    return String(level);
  }
  if (typeof value === "number") {
    if (value === 0) return "off";
    if (value === 1) return "warn";
    if (value === 2) return "error";
  }
  return "on";
}

function normalizeBiomeRuleSetting(value: unknown): string {
  if (typeof value === "string") {
    if (value === "off") return "off";
    return value; // "warn" | "error"
  }
  if (typeof value === "object" && value !== null) {
    const level = (value as Record<string, unknown>).level;
    if (typeof level === "string") return level;
  }
  return "on";
}

// ── Rendering ─────────────────────────────────────────────────────────

/**
 * Render config constraints as a markdown section with actionable directives.
 */
export function renderConstraintsSection(constraints: ConfigConstraints): string | null {
  const lines: string[] = [];

  // TypeScript constraints
  if (constraints.typescript) {
    const ts = constraints.typescript;

    if (ts.strict) {
      lines.push("- **Must**: TypeScript strict mode — no implicit any, strict null checks");
    }

    for (const opt of ts.otherStrict) {
      switch (opt) {
        case "exactOptionalPropertyTypes":
          lines.push("- **Must**: `exactOptionalPropertyTypes` enabled — distinguish `undefined` from missing");
          break;
        case "noUncheckedIndexedAccess":
          lines.push("- **Must**: `noUncheckedIndexedAccess` — index access returns `T | undefined`");
          break;
        case "noPropertyAccessFromIndexSignature":
          lines.push("- **Must**: `noPropertyAccessFromIndexSignature` — use bracket notation for index signatures");
          break;
        case "noImplicitAny":
          lines.push("- **Must**: `noImplicitAny` — all values must have explicit types");
          break;
        case "strictNullChecks":
          lines.push("- **Must**: strict null checks enabled");
          break;
        default:
          lines.push(`- **Must**: \`${opt}\` enabled`);
      }
    }

    if (ts.target) {
      lines.push(`- **Target**: TypeScript target \`${ts.target}\``);
    }
  }

  // Linter constraints
  if (constraints.linter) {
    for (const rule of constraints.linter.keyRules) {
      const prefix = rule.setting === "error" ? "**Must**" : "**Prefer**";
      lines.push(`- ${prefix}: ${rule.impact} (enforced by \`${rule.rule}\`)`);
    }
  }

  // Formatter constraints
  if (constraints.formatter) {
    const f = constraints.formatter;
    const parts: string[] = [];
    parts.push(f.indent);
    parts.push(`${f.quotes} quotes`);
    parts.push(f.semicolons ? "semicolons" : "no semicolons");
    lines.push(`- **Style**: ${parts.join(", ")} (${f.tool})`);
  }

  // Go constraints
  if (constraints.go) {
    lines.push(`- **Must**: Target Go ${constraints.go.version} or later.`);
  }

  // Rust constraints
  if (constraints.rust) {
    lines.push(`- **Must**: Use Rust edition ${constraints.rust.edition}.`);
    if (constraints.rust.clippy?.length) {
      for (const rule of constraints.rust.clippy) {
        lines.push(`- **Prefer**: Follow clippy::${rule} lint rules.`);
      }
    }
  }

  // Python constraints
  if (constraints.python) {
    if (constraints.python.version) {
      lines.push(`- **Must**: Support Python ${constraints.python.version}.`);
    }
    if (constraints.python.mypy?.strict) {
      lines.push("- **Must**: mypy strict mode enabled.");
    }
    if (constraints.python.ruff?.length) {
      lines.push(`- **Prefer**: Follow ruff rule selections: ${constraints.python.ruff.join(", ")}.`);
    }
  }

  if (lines.length === 0) return null;

  return "## Config Constraints\n\n" + lines.join("\n");
}
