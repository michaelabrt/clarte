import * as p from "@clack/prompts";
import type { DetectedContext, IDETarget, ProjectConfig, UserAnswers } from "../types.js";
import { theme as t } from "../theme.js";
import { ExitCode } from "../errors.js";
import { summarizeDetection } from "../detect/detect.js";
import { SNAPSHOT_LANGUAGES } from "../config/thresholds.js";

/**
 * Run the interactive prompt flow. Takes the auto-detected context
 * and asks the user to fill in what couldn't be auto-detected.
 *
 * When `defaults` is provided (from .clarte.json + --reconfigure),
 * prompt values are pre-filled so the user can just press Enter to keep them.
 *
 * The `isReconfigure` flag indicates we're running via --reconfigure,
 * which shows additional prompts (snapshot toggle, stack corrections).
 */
export async function runPrompts(
  detected: DetectedContext,
  defaults?: ProjectConfig | null,
  isReconfigure = false,
): Promise<UserAnswers> {
  // 1. IDE/tool selection
  const ideOptions = [
    { value: "claude" as const, label: "Claude Code" },
    { value: "cursor" as const, label: "Cursor" },
    { value: "opencode" as const, label: "OpenCode" },
    { value: "copilot" as const, label: "GitHub Copilot" },
    { value: "windsurf" as const, label: "Windsurf" },
    { value: "cline" as const, label: "Cline" },
    { value: "continue" as const, label: "Continue.dev" },
    { value: "generic" as const, label: "Other (generic CONTEXT.md)" },
  ];

  const ides = (await p.multiselect({
    message: t.text("Which AI coding tools do you use? (select all that apply)"),
    options: ideOptions,
    initialValues: defaults?.ides ?? (defaults?.ide ? [defaults.ide] : undefined),
    required: true,
  })) as IDETarget[] | symbol;

  if (p.isCancel(ides)) {
    p.cancel("Cancelled.");
    process.exit(ExitCode.SUCCESS);
  }

  // 2. Stack corrections (only on --reconfigure)
  let stackConfirmed = true;
  let stackCorrections = defaults?.stackCorrections ?? "";

  if (isReconfigure) {
    const stackSummary = summarizeDetection(detected);
    if (stackSummary) {
      const confirm = await p.confirm({
        message: t.text(`Detected: ${stackSummary}. Correct?`),
        active: t.soft("Yes"),
        inactive: t.soft("No"),
      });

      if (p.isCancel(confirm)) {
        p.cancel("Cancelled.");
        process.exit(ExitCode.SUCCESS);
      }

      stackConfirmed = confirm;

      if (!confirm) {
        const corrections = await p.text({
          message: t.text("What should I correct? (describe your actual stack)"),
          placeholder: "e.g. It's actually Next.js 15 + Prisma, not plain React",
          defaultValue: defaults?.stackCorrections || undefined,
        });

        if (p.isCancel(corrections)) {
          p.cancel("Cancelled.");
          process.exit(ExitCode.SUCCESS);
        }

        stackCorrections = corrections;
      }
    }
  }

  // 3. Project purpose
  const projectPurpose = await p.text({
    message: t.text("What does this project do? (1-2 sentences)"),
    placeholder: "e.g. A mobile AI chat app connecting to OpenAI, Anthropic, and Google APIs",
    defaultValue: defaults?.projectPurpose || undefined,
    validate: (value) => {
      if (!value?.trim()) return "Please describe your project briefly.";
    },
  });

  if (p.isCancel(projectPurpose)) {
    p.cancel("Cancelled.");
    process.exit(ExitCode.SUCCESS);
  }

  // 4. Key patterns, conventions, and gotchas (merged into one prompt)
  // If old config had separate gotchas, merge them into the default value
  let patternsDefault = defaults?.keyPatterns || "";
  if (defaults?.gotchas) {
    patternsDefault = patternsDefault
      ? `${patternsDefault}\nGotchas: ${defaults.gotchas}`
      : `Gotchas: ${defaults.gotchas}`;
  }

  const keyPatterns = await p.text({
    message: t.text("Any key patterns, conventions, or gotchas? (optional, press Enter to skip)"),
    placeholder: "e.g. Zustand for state, never use FadeIn on ternary, angular commit style",
    defaultValue: patternsDefault,
  });

  if (p.isCancel(keyPatterns)) {
    p.cancel("Cancelled.");
    process.exit(ExitCode.SUCCESS);
  }

  // 5. Code snapshot (auto-enabled for supported languages on first run;
  //    only prompted on --reconfigure)
  let generateSnapshot = false;
  let snapshotPaths: string[] = defaults?.snapshotPaths ?? [];
  const supportsSnapshot = SNAPSHOT_LANGUAGES.has(detected.language);

  if (supportsSnapshot) {
    if (isReconfigure) {
      // On --reconfigure, let the user choose
      const snapshotChoice = (await p.select({
        message: t.text("Code snapshot (extracts types, function signatures, class definitions)"),
        options: [
          { value: "auto" as const, label: "Auto-detect key files" },
          { value: "custom" as const, label: "Custom paths" },
          { value: "no" as const, label: "Disable" },
        ],
        initialValue: defaults?.generateSnapshot
          ? defaults.snapshotPaths.length > 0
            ? ("custom" as const)
            : ("auto" as const)
          : ("auto" as const),
      })) as "auto" | "no" | "custom" | symbol;

      if (p.isCancel(snapshotChoice)) {
        p.cancel("Cancelled.");
        process.exit(ExitCode.SUCCESS);
      }

      if (snapshotChoice === "auto") {
        generateSnapshot = true;
        snapshotPaths = [];
      } else if (snapshotChoice === "custom") {
        generateSnapshot = true;
        const paths = await p.text({
          message: t.text("Paths to scan (comma-separated, relative to project root)"),
          placeholder: "e.g. src/types, src/stores, src/components",
          defaultValue: defaults?.snapshotPaths.length ? defaults.snapshotPaths.join(", ") : undefined,
        });

        if (p.isCancel(paths)) {
          p.cancel("Cancelled.");
          process.exit(ExitCode.SUCCESS);
        }

        snapshotPaths = paths
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
    } else {
      // First run: auto-enable snapshot for supported languages
      generateSnapshot = true;
      snapshotPaths = defaults?.snapshotPaths ?? [];
    }
  }

  // 6. Monorepo: per-package context files (conditional)
  let generatePerPackage = false;

  if (detected.monorepo && detected.monorepo.packages.length > 0) {
    const mono = detected.monorepo;
    const pkgNames = mono.packages.map((pkg) => pkg.name).join(", ");

    const perPkg = await p.confirm({
      message: t.text(
        `Monorepo detected (${mono.type}, ${mono.packages.length} packages: ${pkgNames}). Generate per-package context files?`,
      ),
      active: t.soft("Yes"),
      inactive: t.soft("No"),
      initialValue: defaults?.generatePerPackage ?? false,
    });

    if (p.isCancel(perPkg)) {
      p.cancel("Cancelled.");
      process.exit(ExitCode.SUCCESS);
    }

    generatePerPackage = perPkg;
  }

  return {
    ides,
    projectPurpose,
    keyPatterns: keyPatterns ?? "",
    gotchas: "", // Folded into keyPatterns; kept for backward compat
    generateSnapshot,
    snapshotPaths,
    stackConfirmed,
    stackCorrections,
    generatePerPackage,
  };
}
