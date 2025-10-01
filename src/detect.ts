import fs from "node:fs/promises";
import path from "node:path";
import { glob } from "tinyglobby";
import type {
  DetectedContext,
  DetectedFramework,
  Language,
  Linter,
  MonorepoInfo,
  MonorepoPackage,
  PackageManager,
  ProgressCallback,
} from "./types.js";
import { fileExists, readFileOr, readJsonFile, readDirSafe } from "./utils.js";

/** Well-known directories to look for */
const KNOWN_DIRS = [
  "src",
  "app",
  "pages",
  "components",
  "services",
  "stores",
  "store",
  "lib",
  "utils",
  "hooks",
  "api",
  "tests",
  "__tests__",
  "test",
  "public",
  "assets",
  "styles",
  "config",
  "scripts",
  "docs",
  "types",
];

/** Framework detection rules: dependency name -> framework info */
export const FRAMEWORK_MAP: Record<string, string> = {
  // JS/TS
  expo: "Expo",
  "react-native": "React Native",
  next: "Next.js",
  react: "React",
  vue: "Vue",
  nuxt: "Nuxt",
  svelte: "Svelte",
  "@sveltejs/kit": "SvelteKit",
  angular: "Angular",
  "@angular/core": "Angular",
  express: "Express",
  fastify: "Fastify",
  hono: "Hono",
  "nestjs/core": "NestJS",
  "@nestjs/core": "NestJS",
  electron: "Electron",
  tauri: "Tauri",
  // State management
  zustand: "Zustand",
  redux: "Redux",
  "@reduxjs/toolkit": "Redux Toolkit",
  pinia: "Pinia",
  mobx: "MobX",
  jotai: "Jotai",
  recoil: "Recoil",
  // Testing
  jest: "Jest",
  vitest: "Vitest",
  playwright: "Playwright",
  cypress: "Cypress",
  // Styling
  tailwindcss: "Tailwind CSS",
  nativewind: "NativeWind",
  "styled-components": "styled-components",
  "@emotion/react": "Emotion",
  // ORM/DB
  prisma: "Prisma",
  "@prisma/client": "Prisma",
  drizzle: "Drizzle",
  "drizzle-orm": "Drizzle",
  typeorm: "TypeORM",
  mongoose: "Mongoose",
  // Meta-frameworks
  "@remix-run/node": "Remix",
  "@remix-run/react": "Remix",
  astro: "Astro",
  // API
  "@trpc/server": "tRPC",
  "@trpc/client": "tRPC",
  // BaaS
  "@supabase/supabase-js": "Supabase",
};

/** Python framework detection */
const PYTHON_FRAMEWORK_MAP: Record<string, string> = {
  django: "Django",
  flask: "Flask",
  fastapi: "FastAPI",
  starlette: "Starlette",
  sqlalchemy: "SQLAlchemy",
  pydantic: "Pydantic",
  pytest: "pytest",
  celery: "Celery",
};

/**
 * Auto-detect the tech stack of a project at the given root directory.
 */
export async function detectContext(rootDir: string, onProgress?: ProgressCallback): Promise<DetectedContext> {
  const ctx: DetectedContext = {
    rootDir,
    language: "other",
    hasTypeScript: false,
    packageManager: "none",
    linter: "none",
    frameworks: [],
    directories: [],
    dependencies: [],
    isGitRepo: false,
    totalSourceBytes: 0,
    sourceFileCount: 0,
    monorepo: null,
  };

  // Parallel checks for common project markers
  onProgress?.("Checking project markers...");
  const [
    hasGit,
    hasPackageJson,
    hasGoMod,
    hasCargo,
    hasPyproject,
    hasRequirements,
    hasTsConfig,
    hasBiome,
    hasPnpmLock,
    hasYarnLock,
    hasBunLockBin,
    hasBunLockText,
    topEntries,
  ] = await Promise.all([
    fileExists(path.join(rootDir, ".git")),
    readJsonFile(path.join(rootDir, "package.json")),
    fileExists(path.join(rootDir, "go.mod")),
    fileExists(path.join(rootDir, "Cargo.toml")),
    fileExists(path.join(rootDir, "pyproject.toml")),
    fileExists(path.join(rootDir, "requirements.txt")),
    fileExists(path.join(rootDir, "tsconfig.json")),
    fileExists(path.join(rootDir, "biome.json")),
    fileExists(path.join(rootDir, "pnpm-lock.yaml")),
    fileExists(path.join(rootDir, "yarn.lock")),
    fileExists(path.join(rootDir, "bun.lockb")),
    fileExists(path.join(rootDir, "bun.lock")),
    readDirSafe(rootDir),
  ]);

  const hasBunLock = hasBunLockBin || hasBunLockText;

  ctx.isGitRepo = hasGit;

  // -- Detect language + package manager --

  if (hasPackageJson) {
    const pkg = hasPackageJson;
    ctx.language = hasTsConfig ? "typescript" : "javascript";
    ctx.hasTypeScript = hasTsConfig;

    // Package manager
    if (hasPnpmLock) ctx.packageManager = "pnpm";
    else if (hasYarnLock) ctx.packageManager = "yarn";
    else if (hasBunLock) ctx.packageManager = "bun";
    else ctx.packageManager = "npm";

    // Collect all dependency names
    const deps = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    };
    ctx.dependencies = Object.keys(deps);

    // Detect frameworks
    const seen = new Set<string>();
    for (const dep of ctx.dependencies) {
      const framework = FRAMEWORK_MAP[dep];
      if (framework && !seen.has(framework)) {
        seen.add(framework);
        const version = deps[dep]?.replace(/^[\^~>=<\s]+/, "");
        ctx.frameworks.push({ name: framework, version });
      }
    }

    // Detect linter
    if (hasBiome) {
      ctx.linter = "biome";
    } else {
      const hasEslint = ctx.dependencies.includes("eslint") ||
        topEntries.some((e) => e.startsWith(".eslintrc"));
      const hasPrettier = ctx.dependencies.includes("prettier") ||
        topEntries.some((e) => e.startsWith(".prettierrc"));
      if (hasEslint) ctx.linter = "eslint";
      else if (hasPrettier) ctx.linter = "prettier";
    }
  } else if (hasGoMod) {
    ctx.language = "go";
    ctx.packageManager = "go";
    ctx.linter = "gofmt";
  } else if (hasCargo) {
    ctx.language = "rust";
    ctx.packageManager = "cargo";
    ctx.linter = "rustfmt";
  } else if (hasPyproject || hasRequirements) {
    ctx.language = "python";
    // Try to detect pip vs poetry
    if (topEntries.includes("poetry.lock")) ctx.packageManager = "poetry";
    else ctx.packageManager = "pip";

    // Detect Python frameworks from requirements.txt and/or pyproject.toml
    const allPyDeps: string[] = [];
    const seenFw = new Set<string>();

    if (hasRequirements) {
      const reqContent = await readFileOr(path.join(rootDir, "requirements.txt"));
      if (reqContent) {
        const pkgs = reqContent
          .split("\n")
          .map((l) => l.trim().split(/[=<>!~[]/)[0].toLowerCase())
          .filter(Boolean);
        allPyDeps.push(...pkgs);
      }
    }

    if (hasPyproject) {
      const pyDeps = await parsePyprojectDeps(path.join(rootDir, "pyproject.toml"));
      for (const dep of pyDeps) {
        if (!allPyDeps.includes(dep)) allPyDeps.push(dep);
      }
    }

    for (const pkg of allPyDeps) {
      const framework = PYTHON_FRAMEWORK_MAP[pkg];
      if (framework && !seenFw.has(framework)) {
        seenFw.add(framework);
        ctx.frameworks.push({ name: framework });
      }
    }
    ctx.dependencies = allPyDeps;

    // Detect Python linter
    const hasRuffConfig = topEntries.includes("ruff.toml") || topEntries.includes(".ruff.toml");
    if (!hasRuffConfig && topEntries.includes("pyproject.toml")) {
      // Check for [tool.ruff] section in pyproject.toml
      const pyContent = await readFileOr(path.join(rootDir, "pyproject.toml"));
      if (pyContent?.includes("[tool.ruff]")) {
        ctx.linter = "ruff";
      }
    } else if (hasRuffConfig) {
      ctx.linter = "ruff";
    }
  }

  // Report detected stack
  if (ctx.frameworks.length > 0) {
    const fwNames = ctx.frameworks.map((f) => f.name).join(", ");
    const lang = ctx.hasTypeScript ? "TypeScript" : ctx.language !== "other" ? ctx.language : "";
    const parts = [lang, fwNames].filter(Boolean);
    onProgress?.(`Detected: ${parts.join(" + ")}`);
  }

  // -- Detect directories --
  onProgress?.("Scanning directories...");

  for (const dir of KNOWN_DIRS) {
    if (topEntries.includes(dir)) {
      ctx.directories.push(dir);
    }
  }

  // Also check inside src/ for nested structure
  if (topEntries.includes("src")) {
    const srcEntries = await readDirSafe(path.join(rootDir, "src"));
    for (const entry of srcEntries) {
      if (KNOWN_DIRS.includes(entry)) {
        ctx.directories.push(`src/${entry}`);
      }
    }
  }

  // -- Count source files and total size --

  try {
    const extensions = getExtensionsForLanguage(ctx.language);
    const sourceFiles = await glob(
      extensions.map((ext) => `**/*${ext}`),
      {
        cwd: rootDir,
        ignore: [
          "**/node_modules/**",
          "**/dist/**",
          "**/build/**",
          "**/.next/**",
          "**/target/**",
          "**/vendor/**",
          "**/__pycache__/**",
          "**/venv/**",
          "**/.venv/**",
          "**/.Trash/**",
          "**/Library/**",
          "**/.git/**",
        ],
      },
    );

    ctx.sourceFileCount = sourceFiles.length;
    onProgress?.(`Counting ${sourceFiles.length} source files...`);
    const sizes = await Promise.all(
      sourceFiles.map((f) =>
        fs.stat(path.join(rootDir, f)).then((s) => s.size).catch(() => 0),
      ),
    );
    ctx.totalSourceBytes = sizes.reduce((sum, s) => sum + s, 0);
  } catch {
    // Non-critical, leave at 0
  }

  // -- Detect testing framework --
  ctx.testFramework = detectTestFramework(ctx.dependencies);

  // -- Detect CI provider --
  ctx.ciProvider = await detectCiProvider(rootDir, topEntries);

  // -- Detect monorepo --
  ctx.monorepo = await detectMonorepo(rootDir, topEntries);

  // -- Detect secondary languages --
  await detectLanguageBreakdown(ctx, rootDir);

  return ctx;
}

/** Test framework detection: dependency name -> display name */
const TEST_FRAMEWORK_MAP: Record<string, string> = {
  vitest: "Vitest",
  jest: "Jest",
  playwright: "Playwright",
  cypress: "Cypress",
  mocha: "Mocha",
  pytest: "pytest",
};

function detectTestFramework(dependencies: string[]): string | undefined {
  for (const [dep, name] of Object.entries(TEST_FRAMEWORK_MAP)) {
    if (dependencies.includes(dep)) return name;
  }
  return undefined;
}

/** CI provider detection: file/dir pattern -> display name */
const CI_PATTERNS: Array<{ path: string; name: string; isDir?: boolean }> = [
  { path: ".github/workflows", name: "GitHub Actions", isDir: true },
  { path: ".gitlab-ci.yml", name: "GitLab CI" },
  { path: ".circleci", name: "CircleCI", isDir: true },
  { path: "Jenkinsfile", name: "Jenkins" },
  { path: ".travis.yml", name: "Travis CI" },
];

async function detectCiProvider(rootDir: string, topEntries: string[]): Promise<string | undefined> {
  for (const ci of CI_PATTERNS) {
    if (ci.isDir) {
      // Check if directory exists
      if (await fileExists(path.join(rootDir, ci.path))) return ci.name;
    } else {
      if (topEntries.includes(ci.path)) return ci.name;
    }
  }
  return undefined;
}

function getExtensionsForLanguage(lang: Language): string[] {
  switch (lang) {
    case "typescript":
      return [".ts", ".tsx"];
    case "javascript":
      return [".js", ".jsx", ".mjs"];
    case "python":
      return [".py"];
    case "go":
      return [".go"];
    case "rust":
      return [".rs"];
    case "java":
      return [".java"];
    default:
      return [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"];
  }
}

/** Extension to language mapping for secondary language detection */
const EXT_TO_LANGUAGE: Record<string, Language> = {
  ".ts": "typescript", ".tsx": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
};

/**
 * Detect secondary languages in the project.
 * Populates `ctx.languageBreakdown` and `ctx.secondaryLanguages`.
 */
async function detectLanguageBreakdown(ctx: DetectedContext, rootDir: string): Promise<void> {
  // Only scan if we have a primary language that isn't "other"
  if (ctx.language === "other") return;

  try {
    const allSourceFiles = await glob(
      ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs",
       "**/*.py", "**/*.go", "**/*.rs", "**/*.java"],
      {
        cwd: rootDir,
        ignore: [
          "**/node_modules/**", "**/dist/**", "**/build/**",
          "**/.next/**", "**/target/**", "**/vendor/**",
          "**/__pycache__/**", "**/venv/**", "**/.venv/**",
          "**/.Trash/**", "**/Library/**", "**/.git/**",
        ],
      },
    );

    if (allSourceFiles.length === 0) return;

    // Count files per language
    const counts: Record<string, number> = {};
    for (const file of allSourceFiles) {
      const ext = path.extname(file).toLowerCase();
      const lang = EXT_TO_LANGUAGE[ext];
      if (lang) {
        counts[lang] = (counts[lang] ?? 0) + 1;
      }
    }

    // Merge TS and JS counts under the primary if applicable
    if (ctx.language === "typescript" && counts["javascript"]) {
      counts["typescript"] = (counts["typescript"] ?? 0) + counts["javascript"];
      delete counts["javascript"];
    }

    ctx.languageBreakdown = counts;

    // Find secondary languages (>15% of total source files)
    const totalFiles = allSourceFiles.length;
    const threshold = totalFiles * 0.15;
    const secondary: Language[] = [];

    for (const [lang, count] of Object.entries(counts)) {
      if (lang !== ctx.language && count >= threshold) {
        secondary.push(lang as Language);
      }
    }

    if (secondary.length > 0) {
      ctx.secondaryLanguages = secondary;
    }
  } catch {
    // Non-critical
  }
}

/**
 * Detect monorepo tooling and enumerate packages.
 */
async function detectMonorepo(
  rootDir: string,
  topEntries: string[],
): Promise<MonorepoInfo | null> {
  // Determine monorepo type
  const hasTurboJson = topEntries.includes("turbo.json");
  const hasNxJson = topEntries.includes("nx.json");
  const hasPnpmWorkspace = topEntries.includes("pnpm-workspace.yaml");

  let type: MonorepoInfo["type"] | null = null;
  if (hasTurboJson) type = "turborepo";
  else if (hasNxJson) type = "nx";
  else if (hasPnpmWorkspace) type = "pnpm-workspaces";

  if (!type) return null;

  // Resolve workspace package globs
  let packageGlobs: string[] = [];

  if (hasPnpmWorkspace || hasTurboJson) {
    // pnpm-workspace.yaml (also used by Turborepo)
    const yamlContent = await readFileOr(
      path.join(rootDir, "pnpm-workspace.yaml"),
    );
    if (yamlContent) {
      // Simple YAML parse: extract lines under "packages:"
      const lines = yamlContent.split("\n");
      let inPackages = false;
      for (const line of lines) {
        if (/^packages:/i.test(line.trim())) {
          inPackages = true;
          continue;
        }
        if (inPackages) {
          const match = line.match(/^\s+-\s+['"]?([^'"]+)['"]?/);
          if (match) {
            packageGlobs.push(match[1].trim());
          } else if (line.trim() && !line.startsWith(" ") && !line.startsWith("\t")) {
            break; // new top-level key
          }
        }
      }
    }
  }

  if (packageGlobs.length === 0 && hasNxJson) {
    // Nx: check for packages/ or libs/ directories
    for (const dir of ["packages", "libs", "apps"]) {
      if (topEntries.includes(dir)) {
        packageGlobs.push(`${dir}/*`);
      }
    }
  }

  // Fallback: try workspaces field from package.json
  if (packageGlobs.length === 0) {
    const pkg = await readJsonFile(path.join(rootDir, "package.json"));
    if (pkg) {
      const workspaces = pkg.workspaces;
      if (Array.isArray(workspaces)) {
        packageGlobs = workspaces as string[];
      } else if (
        workspaces &&
        typeof workspaces === "object" &&
        Array.isArray((workspaces as Record<string, unknown>).packages)
      ) {
        packageGlobs = (workspaces as Record<string, unknown>)
          .packages as string[];
      }
    }
  }

  if (packageGlobs.length === 0) return null;

  // Resolve globs to actual directories
  const resolvedDirs = await glob(packageGlobs, {
    cwd: rootDir,
    onlyDirectories: true,
    ignore: ["**/node_modules/**"],
    absolute: false,
  });

  // Build package info for each directory
  const packages: MonorepoPackage[] = [];

  for (const dir of resolvedDirs) {
    const pkgJsonPath = path.join(rootDir, dir, "package.json");
    const pkgJson = await readJsonFile(pkgJsonPath);
    if (!pkgJson) continue; // Not a valid package

    const deps = {
      ...(pkgJson.dependencies as Record<string, string> | undefined),
      ...(pkgJson.devDependencies as Record<string, string> | undefined),
    };
    const depNames = Object.keys(deps);

    // Detect frameworks for this package
    const frameworks: DetectedFramework[] = [];
    const seen = new Set<string>();
    for (const dep of depNames) {
      const framework = FRAMEWORK_MAP[dep];
      if (framework && !seen.has(framework)) {
        seen.add(framework);
        const version = deps[dep]?.replace(/^[\^~>=<\s]+/, "");
        frameworks.push({ name: framework, version });
      }
    }

    packages.push({
      name: (pkgJson.name as string) ?? path.basename(dir),
      path: dir,
      dependencies: depNames,
      frameworks,
    });
  }

  if (packages.length === 0) return null;

  return { type, packages };
}

/**
 * Minimal TOML parser for pyproject.toml dependency extraction.
 * Extracts package names from [project.dependencies], [tool.poetry.dependencies],
 * and [project.optional-dependencies.*] sections.
 */
async function parsePyprojectDeps(filePath: string): Promise<string[]> {
  const content = await readFileOr(filePath);
  if (!content) return [];

  const deps: string[] = [];
  const lines = content.split("\n");

  let inDepsSection = false;
  let inPoetryDeps = false;
  let inArrayValue = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headers
    if (trimmed.startsWith("[")) {
      inArrayValue = false;
      if (
        trimmed === "[project.dependencies]" ||
        trimmed === "[project]" ||
        /^\[project\.optional-dependencies\.\w+\]$/.test(trimmed)
      ) {
        inDepsSection = trimmed === "[project.dependencies]" || /optional-dependencies/.test(trimmed);
        inPoetryDeps = false;
        continue;
      }
      if (trimmed === "[tool.poetry.dependencies]") {
        inPoetryDeps = true;
        inDepsSection = false;
        continue;
      }
      // Any other section header ends current section
      inDepsSection = false;
      inPoetryDeps = false;
      continue;
    }

    // Inside [project] section, look for dependencies = [...]
    if (!inDepsSection && !inPoetryDeps) {
      if (trimmed.startsWith("dependencies")) {
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const rest = trimmed.slice(eqIdx + 1).trim();
          if (rest.startsWith("[")) {
            // Inline or multiline array
            const items = extractTomlArrayItems(rest);
            deps.push(...items);
            if (!rest.includes("]")) {
              inArrayValue = true;
              inDepsSection = true;
            }
          }
        }
      }
      continue;
    }

    // Inside [project.dependencies] array continuation
    if (inDepsSection && inArrayValue) {
      if (trimmed === "]" || trimmed.endsWith("]")) {
        const items = extractTomlArrayItems(trimmed);
        deps.push(...items);
        inArrayValue = false;
        inDepsSection = false;
      } else {
        const items = extractTomlArrayItems(trimmed);
        deps.push(...items);
      }
      continue;
    }

    // Inside [project.dependencies] or similar list section
    if (inDepsSection) {
      // PEP 631 format: each line is a quoted dependency string
      const match = trimmed.match(/^["']([^"']+)["']/);
      if (match) {
        const depName = match[1].split(/[=<>!~;\[]/)[0].trim().toLowerCase();
        if (depName) deps.push(depName);
      }
      continue;
    }

    // Inside [tool.poetry.dependencies] section
    if (inPoetryDeps) {
      // Poetry format: package = "version" or package = {version = "..."}
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([\w-]+)\s*=/);
      if (match) {
        const depName = match[1].toLowerCase();
        if (depName !== "python") deps.push(depName);
      }
    }
  }

  return deps;
}

/**
 * Extract package names from TOML array items like '"flask>=2.0"' or '"django"'.
 */
function extractTomlArrayItems(text: string): string[] {
  const items: string[] = [];
  const regex = /["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const depName = m[1].split(/[=<>!~;\[]/)[0].trim().toLowerCase();
    if (depName) items.push(depName);
  }
  return items;
}

/**
 * Build a reverse map: framework display name -> dependency names.
 */
function buildReverseFrameworkMap(): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const [dep, name] of Object.entries(FRAMEWORK_MAP)) {
    const deps = reverse.get(name) ?? [];
    deps.push(dep);
    reverse.set(name, deps);
  }
  return reverse;
}

/**
 * Enrich detected frameworks with actual import counts from the import graph.
 * Filters out frameworks with 0 imports (detected in package.json but never used).
 */
export function enrichFrameworksWithUsage(
  frameworks: DetectedFramework[],
  externalImportCounts: Map<string, number>,
): DetectedFramework[] {
  const reverseMap = buildReverseFrameworkMap();

  return frameworks.map((fw) => {
    const depNames = reverseMap.get(fw.name) ?? [];
    let totalCount = 0;
    for (const dep of depNames) {
      totalCount += externalImportCounts.get(dep) ?? 0;
    }
    return { ...fw, importCount: totalCount };
  });
}

/**
 * Produce a short human-readable summary of the detected stack.
 */
export function summarizeDetection(ctx: DetectedContext): string {
  const parts: string[] = [];

  if (ctx.frameworks.length > 0) {
    parts.push(ctx.frameworks.map((f) => f.name).join(" + "));
  }

  if (ctx.hasTypeScript) {
    parts.push("TypeScript");
  } else if (ctx.language !== "other") {
    parts.push(ctx.language.charAt(0).toUpperCase() + ctx.language.slice(1));
  }

  if (ctx.linter !== "none") {
    parts.push(ctx.linter.charAt(0).toUpperCase() + ctx.linter.slice(1));
  }

  if (ctx.packageManager !== "none") {
    parts.push(ctx.packageManager);
  }

  return parts.join(" + ");
}
