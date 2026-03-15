import { readFileSync } from "node:fs";
import path from "node:path";
import type { ImportGraph } from "../types.js";

/**
 * Extract likely entry point file paths from package.json:
 * - main / module fields
 * - bin fields (string or object)
 * - File args to node/tsx/ts-node in the scripts field
 *
 * Returns paths relative to rootDir (no leading `./`).
 */
export function readPackageEntryPoints(rootDir: string): string[] {
  try {
    const raw = readFileSync(path.join(rootDir, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const entries: string[] = [];

    if (typeof pkg.main === "string") entries.push(pkg.main);
    if (typeof pkg.module === "string") entries.push(pkg.module);

    if (typeof pkg.bin === "string") {
      entries.push(pkg.bin);
    } else if (pkg.bin && typeof pkg.bin === "object") {
      entries.push(...Object.values(pkg.bin as Record<string, string>));
    }

    if (pkg.scripts && typeof pkg.scripts === "object") {
      for (const script of Object.values(pkg.scripts as Record<string, string>)) {
        for (const match of script.matchAll(/\b(?:node|tsx|ts-node(?:-esm)?)\s+([^\s'"]+\.(?:[jt]sx?|mjs|cjs))/g)) {
          entries.push(match[1]);
        }
      }
    }

    return entries.map((e) => e.replace(/^\.\//, "")).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Find dead files: files with zero in-degree (not imported by anything).
 * Excludes entry points, test files, and config files.
 */
export function findDeadFiles(graph: ImportGraph, entryPoints: string[] = []): string[] {
  const entrySet = new Set(entryPoints);
  const dead: string[] = [];

  for (const [file, degree] of graph.inDegree) {
    if (degree > 0) continue;
    if (graph.barrelFiles?.has(file)) continue;
    if (entrySet.has(file)) continue;
    // Skip test files
    if (/\.(test|spec)\.[jt]sx?$/.test(file) || file.includes("__tests__/")) continue;
    // Skip config files
    if (/\.(config|rc)\.[jt]sx?$/.test(file)) continue;
    // Skip TypeScript declaration files
    if (file.endsWith(".d.ts")) continue;
    // Skip Storybook files
    if (/\.stories\.[jt]sx?$/.test(file)) continue;
    // Skip MDX files
    if (file.endsWith(".mdx")) continue;
    // Skip entry points by convention
    const basename = file.split("/").pop() ?? "";
    if (/^(index|main|app|server|cli|worker|seed|migrate|setup|cron|bootstrap|handler|lambda)\.[jt]sx?$/.test(basename))
      continue;
    if (basename === "mod.ts" || basename === "lib.rs" || basename === "main.rs") continue;
    if (
      basename === "main.go" ||
      basename === "doc.go" ||
      basename === "main.py" ||
      basename === "manage.py" ||
      basename === "wsgi.py" ||
      basename === "asgi.py" ||
      basename === "conftest.py" ||
      basename === "__main__.py" ||
      basename === "setup.py" ||
      basename === "build.rs"
    )
      continue;
    // Java entry points
    if (basename.endsWith("Application.java")) continue;

    dead.push(file);
  }

  return dead.sort();
}
