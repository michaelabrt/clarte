import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { DetectedContext, IDETarget, ProgressCallback } from "../types";
import { errorMessage, fileExists, readFileOr, readJsonFile, readDirSafe } from "../utils";
import { FRAMEWORK_MAP, PYTHON_FRAMEWORK_MAP, extractMavenVersion } from "./frameworks";
import { detectMonorepo, parsePyprojectDeps } from "./monorepo";
import { getExtensionsForLanguage, detectLanguageBreakdown } from "./languages";

// Re-export for consumers that import from detect.ts
export { enrichFrameworksWithUsage } from "./frameworks";
export { SECONDARY_LANGUAGE_THRESHOLD } from "./languages";

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

/**
 * Auto-detect the tech stack of a project at the given root directory.
 */
export async function detectContext(rootDir: string, onProgress?: ProgressCallback): Promise<DetectedContext> {
  const warnings: string[] = [];
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

  onProgress?.("Checking project markers...");
  const [
    hasGit,
    packageJson,
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
    hasBunfigToml,
    pomXmlContent,
    hasBuildGradle,
    hasBuildGradleKts,
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
    fileExists(path.join(rootDir, "bunfig.toml")),
    readFileOr(path.join(rootDir, "pom.xml")),
    fileExists(path.join(rootDir, "build.gradle")),
    fileExists(path.join(rootDir, "build.gradle.kts")),
    readDirSafe(rootDir),
  ]);

  const hasBunLock = hasBunLockBin || hasBunLockText;

  ctx.isGitRepo = hasGit;
  if (packageJson) {
    const pkg = packageJson;
    ctx.language = hasTsConfig ? "typescript" : "javascript";
    ctx.hasTypeScript = hasTsConfig;

    if (hasPnpmLock) ctx.packageManager = "pnpm";
    else if (hasYarnLock) ctx.packageManager = "yarn";
    else if (hasBunLock) ctx.packageManager = "bun";
    else ctx.packageManager = "npm";

    const deps = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    };
    ctx.dependencies = Object.keys(deps);

    const seen = new Set<string>();
    for (const dep of ctx.dependencies) {
      const framework = FRAMEWORK_MAP[dep];
      if (framework && !seen.has(framework)) {
        seen.add(framework);
        const version = deps[dep]?.replace(/^[\^~>=<\s]+/, "");
        ctx.frameworks.push({ name: framework, version });
      }
    }

    if (hasBiome) {
      ctx.linter = "biome";
    } else {
      const hasEslint = ctx.dependencies.includes("eslint") || topEntries.some((e) => e.startsWith(".eslintrc"));
      const hasPrettier = ctx.dependencies.includes("prettier") || topEntries.some((e) => e.startsWith(".prettierrc"));
      if (hasEslint) ctx.linter = "eslint";
      else if (hasPrettier) ctx.linter = "prettier";
    }

    if (hasBunfigToml && !seen.has("Bun")) {
      seen.add("Bun");
      ctx.frameworks.push({ name: "Bun" });
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
    if (topEntries.includes("poetry.lock")) ctx.packageManager = "poetry";
    else ctx.packageManager = "pip";

    const allPyDeps: string[] = [];
    const seenFw = new Set<string>();

    if (hasRequirements) {
      const reqContent = await readFileOr(path.join(rootDir, "requirements.txt"));
      if (reqContent) {
        const pkgs = reqContent
          .split("\n")
          .map((l) =>
            l
              .trim()
              .split(/[=<>!~[]/)[0]
              .toLowerCase(),
          )
          .filter(Boolean);
        allPyDeps.push(...pkgs);
      }
    }

    if (hasPyproject) {
      const pyDeps = await parsePyprojectDeps(path.join(rootDir, "pyproject.toml"), warnings);
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

    const hasRuffConfig = topEntries.includes("ruff.toml") || topEntries.includes(".ruff.toml");
    if (!hasRuffConfig && topEntries.includes("pyproject.toml")) {
      const pyContent = await readFileOr(path.join(rootDir, "pyproject.toml"));
      if (pyContent?.includes("[tool.ruff]")) {
        ctx.linter = "ruff";
      }
    } else if (hasRuffConfig) {
      ctx.linter = "ruff";
    }

    // Detect additional Python tools (Black, isort, mypy, flake8)
    const pyContent = hasPyproject ? await readFileOr(path.join(rootDir, "pyproject.toml")) : null;
    const setupCfg = await readFileOr(path.join(rootDir, "setup.cfg"));

    if (allPyDeps.includes("black") || pyContent?.includes("[tool.black]")) {
      if (!seenFw.has("Black")) {
        seenFw.add("Black");
        ctx.frameworks.push({ name: "Black" });
      }
    }
    if (allPyDeps.includes("isort") || pyContent?.includes("[tool.isort]")) {
      if (!seenFw.has("isort")) {
        seenFw.add("isort");
        ctx.frameworks.push({ name: "isort" });
      }
    }
    if (
      allPyDeps.includes("mypy") ||
      topEntries.includes("mypy.ini") ||
      setupCfg?.includes("[mypy]") ||
      pyContent?.includes("[tool.mypy]")
    ) {
      if (!seenFw.has("mypy")) {
        seenFw.add("mypy");
        ctx.frameworks.push({ name: "mypy" });
      }
    }
    if (allPyDeps.includes("flake8") || topEntries.includes(".flake8") || setupCfg?.includes("[flake8]")) {
      if (!seenFw.has("flake8")) {
        seenFw.add("flake8");
        ctx.frameworks.push({ name: "flake8" });
      }
    }
  }

  if (pomXmlContent) {
    if (ctx.language === "other") ctx.language = "java";
    const mavenVersion = extractMavenVersion(pomXmlContent);
    ctx.frameworks.push({ name: "Maven", version: mavenVersion });
  } else if (hasBuildGradle || hasBuildGradleKts) {
    if (ctx.language === "other") ctx.language = "java";
    ctx.frameworks.push({ name: "Gradle" });
  }

  if (ctx.frameworks.length > 0) {
    const fwNames = ctx.frameworks.map((f) => f.name).join(", ");
    const lang = ctx.hasTypeScript ? "TypeScript" : ctx.language !== "other" ? ctx.language : "";
    const parts = [lang, fwNames].filter(Boolean);
    onProgress?.(`Detected: ${parts.join(" + ")}`);
  }

  onProgress?.("Scanning directories...");

  for (const dir of KNOWN_DIRS) {
    if (topEntries.includes(dir)) {
      ctx.directories.push(dir);
    }
  }

  if (topEntries.includes("src")) {
    const srcEntries = await readDirSafe(path.join(rootDir, "src"));
    for (const entry of srcEntries) {
      if (KNOWN_DIRS.includes(entry)) {
        ctx.directories.push(`src/${entry}`);
      }
    }
  }

  const allSourceFiles = await detectLanguageBreakdown(ctx, rootDir);

  try {
    if (allSourceFiles.length > 0) {
      const extensions = new Set(getExtensionsForLanguage(ctx.language));
      const sourceFiles = allSourceFiles.filter((f) => {
        const ext = path.extname(f).toLowerCase();
        return extensions.has(ext);
      });

      ctx.sourceFileCount = sourceFiles.length;
      onProgress?.(`Counting ${sourceFiles.length} source files...`);
      const sizes = await Promise.all(
        sourceFiles.map((f) =>
          fs
            .stat(path.join(rootDir, f))
            .then((s) => s.size)
            .catch(() => 0),
        ),
      );
      ctx.totalSourceBytes = sizes.reduce((sum, s) => sum + s, 0);
    }
  } catch (err: unknown) {
    warnings.push(`Source file counting failed: ${errorMessage(err)}`);
  }

  ctx.testFramework = detectTestFramework(ctx.dependencies);
  ctx.ciProvider = await detectCiProvider(rootDir, topEntries);
  ctx.monorepo = await detectMonorepo(rootDir, topEntries);

  if (warnings.length > 0) {
    ctx.warnings = warnings;
  }

  return ctx;
}

/** Test framework detection in explicit priority order (highest first). */
const TEST_FRAMEWORK_PRIORITY: Array<{ dep: string; name: string }> = [
  { dep: "vitest", name: "Vitest" },
  { dep: "jest", name: "Jest" },
  { dep: "mocha", name: "Mocha" },
  { dep: "playwright", name: "Playwright" },
  { dep: "cypress", name: "Cypress" },
  { dep: "pytest", name: "pytest" },
];

function detectTestFramework(dependencies: string[]): string | undefined {
  for (const { dep, name } of TEST_FRAMEWORK_PRIORITY) {
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
  { path: "vercel.json", name: "Vercel" },
  { path: "netlify.toml", name: "Netlify" },
  { path: "render.yaml", name: "Render" },
  { path: "railway.json", name: "Railway" },
  { path: "railway.toml", name: "Railway" },
  { path: "fly.toml", name: "Fly.io" },
  { path: "bitbucket-pipelines.yml", name: "Bitbucket Pipelines" },
  { path: "azure-pipelines.yml", name: "Azure DevOps" },
];

async function detectCiProvider(rootDir: string, topEntries: string[]): Promise<string | undefined> {
  for (const ci of CI_PATTERNS) {
    if (ci.isDir) {
      if (await fileExists(path.join(rootDir, ci.path))) return ci.name;
    } else {
      if (topEntries.includes(ci.path)) return ci.name;
    }
  }
  return undefined;
}

/**
 * Auto-detect which AI coding tools are in use by checking for filesystem markers.
 */
export async function detectIDEs(rootDir: string): Promise<IDETarget[]> {
  const markers: Array<{ path: string; ide: IDETarget }> = [
    { path: path.join(".cursor", "rules"), ide: "cursor" },
    { path: path.join(".github", "copilot-instructions.md"), ide: "copilot" },
    { path: ".windsurfrules", ide: "windsurf" },
    { path: ".clinerules", ide: "cline" },
    { path: ".continuerules", ide: "continue" },
    { path: "AGENTS.md", ide: "opencode" },
  ];

  const checks = await Promise.all(markers.map((m) => fileExists(path.join(rootDir, m.path))));

  const detected: IDETarget[] = markers.filter((_, i) => checks[i]).map((m) => m.ide);

  // Always include Claude Code (primary target). Other IDEs are additive.
  if (!detected.includes("claude")) detected.unshift("claude");
  return detected;
}

/**
 * Extract a project description from manifest files or README.
 */
export async function detectProjectDescription(rootDir: string): Promise<string | null> {
  const pkg = await readJsonFile(path.join(rootDir, "package.json"));
  if (pkg?.description && typeof pkg.description === "string" && pkg.description.trim()) {
    return pkg.description.trim();
  }

  const cargoContent = await readFileOr(path.join(rootDir, "Cargo.toml"));
  if (cargoContent) {
    try {
      const doc = parseToml(cargoContent) as Record<string, unknown>;
      const pkgSection = doc.package as Record<string, unknown> | undefined;
      if (pkgSection?.description && typeof pkgSection.description === "string") {
        return pkgSection.description.trim();
      }
    } catch {
      // Non-critical
    }
  }

  const pyContent = await readFileOr(path.join(rootDir, "pyproject.toml"));
  if (pyContent) {
    try {
      const doc = parseToml(pyContent) as Record<string, unknown>;
      const project = doc.project as Record<string, unknown> | undefined;
      if (project?.description && typeof project.description === "string") {
        return project.description.trim();
      }
    } catch {
      // Non-critical
    }
  }

  const readme = await readFileOr(path.join(rootDir, "README.md"));
  if (readme) {
    const lines = readme.split("\n");
    const paragraphLines: string[] = [];
    let inParagraph = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("#") || trimmed.startsWith("[![") || trimmed.startsWith("![")) {
        if (inParagraph) break;
        continue;
      }

      if (!trimmed) {
        if (inParagraph) break;
        continue;
      }

      paragraphLines.push(trimmed);
      inParagraph = true;
    }

    if (paragraphLines.length > 0) {
      return paragraphLines.join(" ");
    }
  }

  return null;
}

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
