import * as p from "@clack/prompts";
import type {
  DetectedContext,
  IDETarget,
  ProjectConfig,
  UserAnswers,
} from "./types.js";
import { summarizeDetection } from "./detect.js";

/**
 * Run the interactive prompt flow. Takes the auto-detected context
 * and asks the user to fill in what couldn't be auto-detected.
 *
 * When `defaults` is provided (from .codebrief.json + --reconfigure),
 * prompt values are pre-filled so the user can just press Enter to keep them.
 */
export async function runPrompts(
  detected: DetectedContext,
  defaults?: ProjectConfig | null,
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
    { value: "aider" as const, label: "Aider" },
    { value: "generic" as const, label: "Other (generic CONTEXT.md)" },
  ];

  const ide = (await p.select({
    message: "Which AI coding tool are you using?",
    options: ideOptions,
    initialValue: defaults?.ide,
  })) as IDETarget | symbol;

  if (p.isCancel(ide)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  // 2. Confirm detected stack
  const stackSummary = summarizeDetection(detected);
  let stackConfirmed = true;
  let stackCorrections = defaults?.stackCorrections ?? "";

  if (stackSummary) {
    const confirm = await p.confirm({
      message: `Detected: ${stackSummary}. Correct?`,
    });

    if (p.isCancel(confirm)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    stackConfirmed = confirm;

    if (!confirm) {
      const corrections = await p.text({
        message: "What should I correct? (describe your actual stack)",
        placeholder: "e.g. It's actually Next.js 15 + Prisma, not plain React",
        defaultValue: defaults?.stackCorrections || undefined,
      });

      if (p.isCancel(corrections)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }

      stackCorrections = corrections;
    }
  }

  // 3. Project purpose
  const projectPurpose = await p.text({
    message: "What does this project do? (1-2 sentences)",
    placeholder:
      "e.g. A mobile AI chat app connecting to OpenAI, Anthropic, and Google APIs",
    defaultValue: defaults?.projectPurpose || undefined,
    validate: (value) => {
      if (!value?.trim()) return "Please describe your project briefly.";
    },
  });

  if (p.isCancel(projectPurpose)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  // 4. Key patterns / conventions
  const keyPatterns = await p.text({
    message:
      "Any key coding patterns or conventions? (optional, press Enter to skip)",
    placeholder:
      "e.g. Zustand slices for state, NativeWind for styling, expo/fetch for SSE",
    defaultValue: defaults?.keyPatterns || "",
  });

  if (p.isCancel(keyPatterns)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  // 5. Gotchas / anti-patterns
  const gotchas = await p.text({
    message: "Any critical gotchas or anti-patterns to avoid? (optional)",
    placeholder:
      "e.g. Never use FadeIn/FadeOut on ternary components, no @expo/vector-icons",
    defaultValue: defaults?.gotchas || "",
  });

  if (p.isCancel(gotchas)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  // 6. Code snapshot depth (only for TS/JS projects)
  let generateSnapshot = false;
  let snapshotPaths: string[] = defaults?.snapshotPaths ?? [];

  if (
    detected.language === "typescript" ||
    detected.language === "javascript"
  ) {
    const snapshotChoice = (await p.select({
      message:
        "Generate a code snapshot? (extracts types, store shapes, component props)",
      options: [
        { value: "auto" as const, label: "Yes, auto-detect key files" },
        { value: "no" as const, label: "No, skip code snapshot" },
        { value: "custom" as const, label: "Yes, but let me specify paths" },
      ],
      initialValue: defaults?.generateSnapshot
        ? defaults.snapshotPaths.length > 0
          ? ("custom" as const)
          : ("auto" as const)
        : undefined,
    })) as "auto" | "no" | "custom" | symbol;

    if (p.isCancel(snapshotChoice)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    if (snapshotChoice === "auto") {
      generateSnapshot = true;
      snapshotPaths = [];
    } else if (snapshotChoice === "custom") {
      generateSnapshot = true;
      const paths = await p.text({
        message: "Paths to scan (comma-separated, relative to project root)",
        placeholder: "e.g. src/types, src/stores, src/components",
        defaultValue:
          defaults?.snapshotPaths.length
            ? defaults.snapshotPaths.join(", ")
            : undefined,
      });

      if (p.isCancel(paths)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }

      snapshotPaths = paths
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  // 7. Monorepo: per-package context files
  let generatePerPackage = false;

  if (detected.monorepo && detected.monorepo.packages.length > 0) {
    const mono = detected.monorepo;
    const pkgNames = mono.packages.map((pkg) => pkg.name).join(", ");

    const perPkg = await p.confirm({
      message: `Monorepo detected (${mono.type}, ${mono.packages.length} packages: ${pkgNames}). Generate per-package context files?`,
      initialValue: defaults?.generatePerPackage ?? false,
    });

    if (p.isCancel(perPkg)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    generatePerPackage = perPkg;
  }

  return {
    ide,
    projectPurpose,
    keyPatterns: keyPatterns ?? "",
    gotchas: gotchas ?? "",
    generateSnapshot,
    snapshotPaths,
    stackConfirmed,
    stackCorrections,
    generatePerPackage,
  };
}
