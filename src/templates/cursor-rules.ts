import type { ContextAnalysis, DetectedContext, UserAnswers } from "../types.js";
import { getFrameworkHints } from "./framework-hints.js";
import { buildDirectives, computeFileComplexity } from "./directives.js";

interface CursorRule {
  /** Filename (without path) */
  filename: string;
  /** Frontmatter description */
  description: string;
  /** Glob patterns for file matching */
  globs: string;
  /** Rule body content */
  body: string;
}

/**
 * Generate .cursor/rules/*.md files based on detected project structure.
 */
export async function buildCursorRules(
  ctx: DetectedContext,
  answers: UserAnswers,
  analysis?: ContextAnalysis,
): Promise<CursorRule[]> {
  const rules: CursorRule[] = [];

  // Always create a global rule
  rules.push(await buildGlobalRule(ctx, answers, analysis));

  // Component rule (if components/ directory exists)
  const hasComponents = ctx.directories.some(
    (d) => d.endsWith("components") || d.includes("components/"),
  );
  if (hasComponents) {
    rules.push(buildComponentsRule(ctx));
  }

  // Services rule (if services/ or api/ exists)
  const hasServices = ctx.directories.some(
    (d) =>
      d.endsWith("services") ||
      d.endsWith("api") ||
      d.includes("services/") ||
      d.includes("api/"),
  );
  if (hasServices) {
    rules.push(buildServicesRule(ctx));
  }

  // Stores rule (if stores/ or store/ exists)
  const hasStores = ctx.directories.some(
    (d) =>
      d.endsWith("stores") ||
      d.endsWith("store") ||
      d.includes("stores/") ||
      d.includes("store/"),
  );
  if (hasStores) {
    rules.push(buildStoresRule(ctx));
  }

  return rules;
}

async function buildGlobalRule(ctx: DetectedContext, answers: UserAnswers, analysis?: ContextAnalysis): Promise<CursorRule> {
  const bodyLines: string[] = [
    "# Global Rules",
    "",
    `> Update this rule and the main context file after any architectural or convention change.`,
    `> Prefer using context from the main project file over re-reading source files you already have summaries for.`,
    "",
  ];

  // Add gotchas if provided
  if (answers.gotchas) {
    bodyLines.push("## Gotchas");
    bodyLines.push("");
    const gotchas = answers.gotchas
      .split(/[.\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const g of gotchas) {
      bodyLines.push(`- ${g}`);
    }
    bodyLines.push("");
  }

  // Instability warnings
  if (analysis?.instabilities && analysis.instabilities.length > 0) {
    bodyLines.push("## High-Instability Files");
    bodyLines.push("");
    bodyLines.push(
      "> These files have many dependents but also many dependencies (unstable). Changes here have high blast radius.",
    );
    bodyLines.push("");
    for (const inst of analysis.instabilities) {
      bodyLines.push(`- \`${inst.path}\`: ${(inst.instability * 100).toFixed(0)}% unstable (${inst.fanIn} dependents, ${inst.fanOut} dependencies)`);
    }
    bodyLines.push("");
  }

  // Change coupling warnings
  if (analysis?.gitActivity?.changeCoupling && analysis.gitActivity.changeCoupling.length > 0) {
    bodyLines.push("## Change Coupling");
    bodyLines.push("");
    bodyLines.push(
      "> These file pairs frequently change together. When modifying one, check the other.",
    );
    bodyLines.push("");
    for (const pair of analysis.gitActivity.changeCoupling.slice(0, 5)) {
      bodyLines.push(`- \`${pair.fileA}\` ↔ \`${pair.fileB}\` (${pair.coChangeCount} co-changes, ${(pair.confidence * 100).toFixed(0)}% confidence)`);
    }
    bodyLines.push("");
  }

  // Circular dependency warnings
  if (analysis?.circularDeps && analysis.circularDeps.length > 0) {
    bodyLines.push("## Circular Dependencies");
    bodyLines.push("");
    bodyLines.push(
      "> These circular import chains may cause unexpected behavior. Avoid adding to them.",
    );
    bodyLines.push("");
    for (const dep of analysis.circularDeps) {
      const severity = dep.severity != null
        ? dep.severity === 0 ? " (type-only)" : dep.severity < 1 ? " (mixed)" : ""
        : "";
      const hint = dep.breakHint ? ` -- ${dep.breakHint}` : "";
      bodyLines.push(`- ${dep.chain.join(" -> ")}${severity}${hint}`);
    }
    bodyLines.push("");
  }

  // Framework conventions
  const fwHints = getFrameworkHints(ctx);
  if (fwHints.length > 0) {
    bodyLines.push("## Framework Conventions");
    bodyLines.push("");
    for (const hint of fwHints) {
      bodyLines.push(hint);
    }
    bodyLines.push("");
  }

  // Working guidelines (analysis-derived directives)
  if (analysis) {
    const fileComplexity = analysis.hubFiles?.length
      ? await computeFileComplexity(ctx.rootDir, analysis.hubFiles)
      : undefined;
    const directives = buildDirectives(analysis, ctx, fileComplexity);
    if (directives.length > 0) {
      bodyLines.push("## Working Guidelines");
      bodyLines.push("");
      for (const d of directives) {
        bodyLines.push(`- ${d}`);
      }
      bodyLines.push("");
    }
  }

  // Linter info
  if (ctx.linter !== "none") {
    bodyLines.push(
      `- Linter: **${ctx.linter}**. Run lint before committing.`,
    );
  }

  // Keep context files updated
  bodyLines.push(
    "- After any architectural or convention change, update the relevant context files.",
  );

  const ext = getExtGlob(ctx);

  return {
    filename: "global.md",
    description: "Universal project rules",
    globs: `**/*.${ext}`,
    body: bodyLines.join("\n"),
  };
}

function buildComponentsRule(ctx: DetectedContext): CursorRule {
  const compDir = ctx.directories.find(
    (d) => d.endsWith("components") || d.includes("components/"),
  ) ?? "src/components";

  const bodyLines: string[] = [
    "# UI Components",
    "",
    "> Update this rule when component conventions change.",
    "",
    "## Conventions",
    "",
  ];

  // Add framework-specific hints
  const hasReact = ctx.frameworks.some(
    (f) => f.name === "React" || f.name === "React Native",
  );
  const hasTailwind = ctx.frameworks.some(
    (f) => f.name === "Tailwind CSS" || f.name === "NativeWind",
  );

  if (hasReact) {
    bodyLines.push("- Functional components with hooks (no class components)");
    bodyLines.push("- Use `memo()` for expensive renders");
  }

  if (hasTailwind) {
    bodyLines.push(
      "- Use `className` for layout/styling via Tailwind. Inline `style` only for dynamic/theme values.",
    );
  }

  bodyLines.push(
    "- Props interfaces defined adjacent to the component",
  );
  bodyLines.push("- Keep components focused -- extract sub-components when complexity grows");

  // Also glob the app screens if they exist
  const appGlob = ctx.directories.includes("app") ? ", app/**/*.tsx" : "";

  return {
    filename: "ui-components.md",
    description: "Component conventions and patterns",
    globs: `${compDir}/**/*.{ts,tsx,js,jsx}${appGlob}`,
    body: bodyLines.join("\n"),
  };
}

function buildServicesRule(ctx: DetectedContext): CursorRule {
  const svcDir = ctx.directories.find(
    (d) =>
      d.endsWith("services") ||
      d.endsWith("api") ||
      d.includes("services/") ||
      d.includes("api/"),
  ) ?? "src/services";

  // Check if hooks dir exists (for useChat-like patterns)
  const hooksGlob = ctx.directories.some((d) => d.endsWith("hooks"))
    ? `, ${ctx.directories.find((d) => d.endsWith("hooks"))}/**/*.{ts,js}`
    : "";

  const bodyLines: string[] = [
    "# Services & API Layer",
    "",
    "> Update this rule when service patterns or API conventions change.",
    "",
    "## Conventions",
    "",
    "- Services should be pure functions or classes, not React hooks",
    "- Error handling: always catch and provide meaningful error messages",
    "- Keep service functions focused on a single responsibility",
  ];

  return {
    filename: "services.md",
    description: "Service and API layer patterns",
    globs: `${svcDir}/**/*.{ts,js}${hooksGlob}`,
    body: bodyLines.join("\n"),
  };
}

function buildStoresRule(ctx: DetectedContext): CursorRule {
  const storeDir = ctx.directories.find(
    (d) =>
      d.endsWith("stores") ||
      d.endsWith("store") ||
      d.includes("stores/") ||
      d.includes("store/"),
  ) ?? "src/stores";

  const bodyLines: string[] = [
    "# State Management",
    "",
    "> Update this rule when state patterns change.",
    "",
    "## Conventions",
    "",
  ];

  // Detect state management library
  const hasZustand = ctx.frameworks.some((f) => f.name === "Zustand");
  const hasRedux = ctx.frameworks.some(
    (f) => f.name === "Redux" || f.name === "Redux Toolkit",
  );
  const hasPinia = ctx.frameworks.some((f) => f.name === "Pinia");

  if (hasZustand) {
    bodyLines.push(
      "- **Zustand** slice architecture: each slice is a `StateCreator` accessing full state via `get()`",
    );
    bodyLines.push("- Immutable updates: always spread state");
    bodyLines.push("- Cross-slice access via `get()` (not separate store imports)");
  } else if (hasRedux) {
    bodyLines.push("- **Redux Toolkit** slices with `createSlice`");
    bodyLines.push("- Async logic in thunks (`createAsyncThunk`)");
    bodyLines.push("- Selectors for reading state, dispatches for writing");
  } else if (hasPinia) {
    bodyLines.push("- **Pinia** stores with composition API");
    bodyLines.push("- Getters for derived state, actions for mutations");
  } else {
    bodyLines.push("- Keep state updates immutable");
    bodyLines.push("- Separate concerns into distinct store modules");
  }

  bodyLines.push("- Silent failures for persistence (app should work even if storage fails)");

  return {
    filename: "stores.md",
    description: "State management patterns",
    globs: `${storeDir}/**/*.{ts,js}`,
    body: bodyLines.join("\n"),
  };
}

/**
 * Get the right file extension glob for the project's language.
 */
function getExtGlob(ctx: DetectedContext): string {
  switch (ctx.language) {
    case "typescript":
      return "{ts,tsx}";
    case "javascript":
      return "{js,jsx}";
    case "python":
      return "py";
    case "go":
      return "go";
    case "rust":
      return "rs";
    default:
      return "{ts,tsx,js,jsx}";
  }
}

/**
 * Format a CursorRule as the full file content with frontmatter.
 */
export function renderCursorRule(rule: CursorRule): string {
  return [
    "---",
    `description: ${rule.description}`,
    `globs: ${rule.globs}`,
    "---",
    "",
    rule.body,
    "",
  ].join("\n");
}
