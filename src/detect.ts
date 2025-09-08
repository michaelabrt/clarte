import path from "node:path";
import fg from "fast-glob";
import type {
  DetectedContext,
  DetectedFramework,
  Language,
  Linter,
  PackageManager,
} from "./types.js";
import { fileExists, readJsonFile, readDirSafe } from "./utils.js";

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
const FRAMEWORK_MAP: Record<string, string> = {
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
export async function detectContext(rootDir: string): Promise<DetectedContext> {
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
  };

  // Parallel checks for common project markers
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
    hasBunLock,
    topEntries,
  ] = await Promise.all([
    fileExists(path.join(rootDir, ".git")),
    readJsonFile(path.join(rootDir, "package.json")),
    fileExists(path.join(rootDir, "go.mod")),
    fileExists(path.join(rootDir, "Cargo.toml")),
    readJsonFile(path.join(rootDir, "pyproject.toml")), // won't parse TOML but that's ok
    fileExists(path.join(rootDir, "requirements.txt")),
    fileExists(path.join(rootDir, "tsconfig.json")),
    fileExists(path.join(rootDir, "biome.json")),
    fileExists(path.join(rootDir, "pnpm-lock.yaml")),
    fileExists(path.join(rootDir, "yarn.lock")),
    fileExists(path.join(rootDir, "bun.lockb")),
    readDirSafe(rootDir),
  ]);

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
        const version = deps[dep]?.replace(/^[\^~>=<]/, "");
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

    // Detect Python frameworks from requirements.txt
    if (hasRequirements) {
      const { readFileOr } = await import("./utils.js");
      const reqContent = await readFileOr(path.join(rootDir, "requirements.txt"));
      if (reqContent) {
        const pkgs = reqContent
          .split("\n")
          .map((l) => l.trim().split(/[=<>!~[]/)[0].toLowerCase())
          .filter(Boolean);
        for (const pkg of pkgs) {
          const framework = PYTHON_FRAMEWORK_MAP[pkg];
          if (framework) {
            ctx.frameworks.push({ name: framework });
          }
        }
        ctx.dependencies = pkgs;
      }
    }

    // Detect Python linter
    const hasRuff = topEntries.includes("ruff.toml") ||
      topEntries.some((e) => e === "pyproject.toml");
    if (hasRuff) ctx.linter = "ruff";
    else ctx.linter = "none";
  }

  // -- Detect directories --

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
    const sourceFiles = await fg(
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
        ],
        stats: true,
      },
    );

    ctx.sourceFileCount = sourceFiles.length;
    ctx.totalSourceBytes = sourceFiles.reduce(
      (sum, f) => sum + (f.stats?.size ?? 0),
      0,
    );
  } catch {
    // Non-critical, leave at 0
  }

  return ctx;
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
