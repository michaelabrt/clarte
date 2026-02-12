import { spawn } from "node:child_process";
import { loadPersistedGraph } from "../graph/persist.js";
import { resolveEditTargets } from "./resolve-targets.js";
import { formatEditDirective } from "./format-directive.js";

/**
 * Run `claude -p` with graph-derived edit-target directives appended to the system prompt.
 * Falls through to plain `claude -p` if no graph exists or no targets are resolved.
 *
 * Returns the exit code of the spawned process.
 */
export async function runRunMode(
  rootDir: string,
  taskDescription: string,
  passthroughArgs: string[],
  verbose: boolean,
): Promise<number> {
  const graph = await loadPersistedGraph(rootDir);

  let directive = "";
  if (graph) {
    const targets = resolveEditTargets(taskDescription, graph);
    directive = formatEditDirective(targets);
    if (verbose && directive) {
      console.error(`[clarte] Edit-target directive: ${directive}`);
    }
    if (verbose && !directive) {
      console.error("[clarte] No edit targets resolved, passing through without directive.");
    }
  } else if (verbose) {
    console.error("[clarte] No .clarte/graph.json found, passing through without directive.");
  }

  const args = ["-p", taskDescription, ...passthroughArgs];
  if (directive) {
    args.push("--append-system-prompt", directive);
  }

  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      stdio: "inherit",
      cwd: rootDir,
    });

    child.on("error", (err) => {
      console.error(`[clarte] Failed to spawn claude: ${err.message}`);
      resolve(1);
    });

    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}
