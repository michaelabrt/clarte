import * as p from "@clack/prompts";
import type { DetectedContext, IDETarget, UserAnswers } from "./types.js";
import { summarizeDetection } from "./detect.js";

/**
 * Run the interactive prompt flow. Takes the auto-detected context
 * and asks the user to fill in what couldn't be auto-detected.
 */
export async function runPrompts(detected: DetectedContext): Promise<UserAnswers> {
  // 1. IDE/tool selection
  const ide = (await p.select({
    message: "Which AI coding tool are you using?",
    options: [
      { value: "claude" as const, label: "Claude Code" },
      { value: "cursor" as const, label: "Cursor" },
      { value: "opencode" as const, label: "OpenCode" },
      { value: "generic" as const, label: "Other (generic CONTEXT.md)" },
    ],
  })) as IDETarget | symbol;

  if (p.isCancel(ide)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  // 2. Confirm detected stack
  const stackSummary = summarizeDetection(detected);
  let stackConfirmed = true;
  let stackCorrections = "";

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
    placeholder: "e.g. A mobile AI chat app connecting to OpenAI, Anthropic, and Google APIs",
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
    message: "Any key coding patterns or conventions? (optional, press Enter to skip)",
    placeholder: "e.g. Zustand slices for state, NativeWind for styling, expo/fetch for SSE",
    defaultValue: "",
  });

  if (p.isCancel(keyPatterns)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  // 5. Gotchas / anti-patterns
  const gotchas = await p.text({
    message: "Any critical gotchas or anti-patterns to avoid? (optional)",
    placeholder: "e.g. Never use FadeIn/FadeOut on ternary components, no @expo/vector-icons",
    defaultValue: "",
  });

  if (p.isCancel(gotchas)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  // 6. Code snapshot depth (only for TS/JS projects)
  let generateSnapshot = false;
  let snapshotPaths: string[] = [];

  if (detected.language === "typescript" || detected.language === "javascript") {
    const snapshotChoice = (await p.select({
      message: "Generate a code snapshot? (extracts types, store shapes, component props)",
      options: [
        { value: "auto" as const, label: "Yes, auto-detect key files" },
        { value: "no" as const, label: "No, skip code snapshot" },
        { value: "custom" as const, label: "Yes, but let me specify paths" },
      ],
    })) as "auto" | "no" | "custom" | symbol;

    if (p.isCancel(snapshotChoice)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    if (snapshotChoice === "auto") {
      generateSnapshot = true;
    } else if (snapshotChoice === "custom") {
      generateSnapshot = true;
      const paths = await p.text({
        message: "Paths to scan (comma-separated, relative to project root)",
        placeholder: "e.g. src/types, src/stores, src/components",
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

  return {
    ide,
    projectPurpose,
    keyPatterns: keyPatterns ?? "",
    gotchas: gotchas ?? "",
    generateSnapshot,
    snapshotPaths,
    stackConfirmed,
    stackCorrections,
  };
}
