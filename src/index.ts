import path from "node:path";
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { detectContext } from "./detect.js";
import { runPrompts } from "./prompts.js";
import { generateSnapshot } from "./snapshot.js";
import { generateFiles } from "./generate.js";
import { printSummary } from "./summary.js";

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const targetDir = args.find((a) => !a.startsWith("-")) ?? process.cwd();
  const rootDir = path.resolve(targetDir);

  console.log("");
  p.intro(pc.bold(" context-pilot "));

  if (dryRun) {
    p.log.warn(pc.yellow("DRY RUN — no files will be written"));
  }

  p.log.info(`Analyzing ${pc.cyan(rootDir)}`);

  // Step 1: Auto-detect
  const spinner = p.spinner();
  spinner.start("Detecting tech stack...");
  const detected = await detectContext(rootDir);
  spinner.stop("Detection complete.");

  // Step 2: Interactive prompts
  const answers = await runPrompts(detected);

  // Step 3: Code snapshot (if requested)
  let snapshot = null;
  if (answers.generateSnapshot) {
    spinner.start("Scanning source files for code snapshot...");
    snapshot = await generateSnapshot(detected, answers.snapshotPaths);
    const count = snapshot.entries.length;
    spinner.stop(
      count > 0
        ? `Found ${count} type${count === 1 ? "" : "s"}/signature${count === 1 ? "" : "s"}.`
        : "No extractable types found (snapshot will be skipped).",
    );

    if (count === 0) {
      snapshot = null;
    }
  }

  // Step 4: Generate files
  spinner.start(
    dryRun ? "Preparing context files..." : "Generating context files...",
  );
  const files = await generateFiles(detected, answers, snapshot, force, dryRun);
  spinner.stop(
    dryRun
      ? `Would generate ${files.length} file${files.length === 1 ? "" : "s"}.`
      : `Generated ${files.length} file${files.length === 1 ? "" : "s"}.`,
  );

  if (files.length === 0) {
    p.outro("Nothing to write. Done!");
    return;
  }

  // Step 5: Summary + token estimate
  printSummary(files, detected);

  if (dryRun) {
    p.outro(
      pc.yellow("DRY RUN complete — ") +
        pc.dim("no files were written. Remove --dry-run to generate."),
    );
    return;
  }

  // Step 6: Handoff (optional)
  const toolCommand = getToolCommand(answers.ide);
  if (toolCommand) {
    const launch = await p.confirm({
      message: `Launch ${getToolName(answers.ide)}?`,
      initialValue: false,
    });

    if (!p.isCancel(launch) && launch) {
      p.outro(`Launching ${getToolName(answers.ide)}...`);
      try {
        execSync(toolCommand, { stdio: "inherit", cwd: rootDir });
      } catch {
        // Tool may not be installed
        console.log(
          pc.yellow(
            `  Could not run '${toolCommand}'. Make sure the tool is installed.`,
          ),
        );
      }
      return;
    }
  }

  p.outro(
    pc.green("Done! ") +
      pc.dim(
        "Your context files are ready. They are living documents — keep them up to date as your project evolves.",
      ),
  );
}

function getToolCommand(ide: string): string | null {
  switch (ide) {
    case "claude":
      return "claude";
    case "cursor":
      return "cursor .";
    case "opencode":
      return "opencode";
    case "windsurf":
      return "windsurf .";
    case "aider":
      return "aider";
    default:
      return null;
  }
}

function getToolName(ide: string): string {
  switch (ide) {
    case "claude":
      return "Claude Code";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
    case "copilot":
      return "GitHub Copilot";
    case "windsurf":
      return "Windsurf";
    case "cline":
      return "Cline";
    case "continue":
      return "Continue.dev";
    case "aider":
      return "Aider";
    default:
      return ide;
  }
}

main().catch((err) => {
  console.error(pc.red("Fatal error:"), err);
  process.exit(1);
});
