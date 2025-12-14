import path from "node:path";
import { glob } from "tinyglobby";
import type { DetectedFramework, MonorepoInfo, MonorepoPackage } from "../types.js";
import { readFileOr, readJsonFile } from "../utils.js";
import { FRAMEWORK_MAP } from "./frameworks.js";

/**
 * Detect monorepo tooling and enumerate packages.
 */
export async function detectMonorepo(rootDir: string, topEntries: string[]): Promise<MonorepoInfo | null> {
  const hasTurboJson = topEntries.includes("turbo.json");
  const hasNxJson = topEntries.includes("nx.json");
  const hasPnpmWorkspace = topEntries.includes("pnpm-workspace.yaml");

  let type: MonorepoInfo["type"] | null = null;
  if (hasTurboJson) type = "turborepo";
  else if (hasNxJson) type = "nx";
  else if (hasPnpmWorkspace) type = "pnpm-workspaces";

  if (!type) {
    const pkg = await readJsonFile(path.join(rootDir, "package.json"));
    if (pkg) {
      const workspaces = pkg.workspaces;
      const hasWorkspaces =
        Array.isArray(workspaces) ||
        (workspaces &&
          typeof workspaces === "object" &&
          Array.isArray((workspaces as Record<string, unknown>).packages));
      if (hasWorkspaces) type = "npm-workspaces";
    }
  }

  if (!type) return null;

  let packageGlobs: string[] = [];

  if (hasPnpmWorkspace || hasTurboJson) {
    const yamlContent = await readFileOr(path.join(rootDir, "pnpm-workspace.yaml"));
    if (yamlContent) {
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
            break;
          }
        }
      }
    }
  }

  if (packageGlobs.length === 0 && hasNxJson) {
    for (const dir of ["packages", "libs", "apps"]) {
      if (topEntries.includes(dir)) {
        packageGlobs.push(`${dir}/*`);
      }
    }
  }

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
        packageGlobs = (workspaces as Record<string, unknown>).packages as string[];
      }
    }
  }

  if (packageGlobs.length === 0) return null;

  let resolvedDirs: string[];
  try {
    resolvedDirs = await glob(packageGlobs, {
      cwd: rootDir,
      onlyDirectories: true,
      ignore: ["**/node_modules/**"],
      absolute: false,
    });
  } catch {
    return null;
  }

  const packages: MonorepoPackage[] = [];

  for (const dir of resolvedDirs) {
    const pkgJsonPath = path.join(rootDir, dir, "package.json");
    const pkgJson = await readJsonFile(pkgJsonPath);
    if (!pkgJson) continue;

    const deps = {
      ...(pkgJson.dependencies as Record<string, string> | undefined),
      ...(pkgJson.devDependencies as Record<string, string> | undefined),
    };
    const depNames = Object.keys(deps);

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
 * Extract dependency names from a pyproject.toml file using smol-toml.
 */
export async function parsePyprojectDeps(filePath: string, warnings?: string[]): Promise<string[]> {
  const { parse: parseToml } = await import("smol-toml");
  const content = await readFileOr(filePath);
  if (!content) return [];

  try {
    const doc = parseToml(content) as Record<string, unknown>;
    const deps: string[] = [];

    const project = doc.project as Record<string, unknown> | undefined;
    if (project) {
      const projDeps = project.dependencies;
      if (Array.isArray(projDeps)) {
        for (const dep of projDeps) {
          if (typeof dep === "string") {
            const name = dep
              .split(/[=<>!~;[]/)[0]
              .trim()
              .toLowerCase();
            if (name) deps.push(name);
          }
        }
      }

      const optDeps = project["optional-dependencies"] as Record<string, unknown> | undefined;
      if (optDeps && typeof optDeps === "object") {
        for (const group of Object.values(optDeps)) {
          if (Array.isArray(group)) {
            for (const dep of group) {
              if (typeof dep === "string") {
                const name = dep
                  .split(/[=<>!~;[]/)[0]
                  .trim()
                  .toLowerCase();
                if (name) deps.push(name);
              }
            }
          }
        }
      }
    }

    const tool = doc.tool as Record<string, unknown> | undefined;
    const poetry = tool?.poetry as Record<string, unknown> | undefined;
    const poetryDeps = poetry?.dependencies as Record<string, unknown> | undefined;
    if (poetryDeps && typeof poetryDeps === "object") {
      for (const key of Object.keys(poetryDeps)) {
        const name = key.toLowerCase();
        if (name !== "python") deps.push(name);
      }
    }

    return deps;
  } catch (err: unknown) {
    warnings?.push(`Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
