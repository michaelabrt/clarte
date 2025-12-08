import type { ImportGraph } from "../types.js";

/**
 * Find dead files: files with zero in-degree (not imported by anything).
 * Excludes entry points, test files, and config files.
 */
export function findDeadFiles(graph: ImportGraph, entryPoints: string[] = []): string[] {
  const entrySet = new Set(entryPoints);
  const dead: string[] = [];

  for (const [file, degree] of graph.inDegree) {
    if (degree > 0) continue;
    if (entrySet.has(file)) continue;
    // Skip test files
    if (/\.(test|spec)\.[jt]sx?$/.test(file) || file.includes("__tests__/")) continue;
    // Skip config files
    if (/\.(config|rc)\.[jt]sx?$/.test(file)) continue;
    // Skip entry points by convention
    const basename = file.split("/").pop() ?? "";
    if (/^(index|main|app|server|cli|worker|seed|migrate|setup|cron|bootstrap|handler|lambda)\.[jt]sx?$/.test(basename))
      continue;
    if (basename === "mod.ts" || basename === "lib.rs" || basename === "main.rs") continue;
    if (
      basename === "main.go" ||
      basename === "main.py" ||
      basename === "manage.py" ||
      basename === "wsgi.py" ||
      basename === "asgi.py"
    )
      continue;

    dead.push(file);
  }

  return dead.sort();
}
