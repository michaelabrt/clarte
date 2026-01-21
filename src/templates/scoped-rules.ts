/**
 * Experiment 1: Path-scoped rules.
 * Generates additional .claude/rules/clarte-{dir}.md files with paths: frontmatter.
 * Claude Code loads these only when the agent reads files in that directory.
 */

import type { ContextAnalysis, DetectedContext, ImportGraph } from "../types.js";
import { buildDirectives, computeFileComplexity } from "./directives.js";
import { groupDirectivesByScope, type ScopedDirective } from "./directive-scope.js";

/** A scoped rule file to be written to .claude/rules/ */
export interface ScopedRule {
  /** Filename (e.g. "clarte-src-core.md") */
  filename: string;
  /** Directory scope (e.g. "src/core") */
  scope: string;
  /** Glob patterns for paths: frontmatter */
  paths: string[];
  /** Markdown body (without frontmatter) */
  body: string;
}

const MIN_DIRECTIVES = 2;
const MAX_CHARS = 1000;

/**
 * Build scoped rule files from analysis directives.
 * Only generates a file when a directory has >= 2 directives and fits within budget.
 */
export async function buildScopedRules(
  analysis: ContextAnalysis,
  ctx: DetectedContext,
  graph?: ImportGraph,
): Promise<ScopedRule[]> {
  const fileComplexity =
    analysis.hubFiles.length > 0 ? await computeFileComplexity(ctx.rootDir, analysis.hubFiles) : undefined;
  const directives = buildDirectives(analysis, ctx, fileComplexity, graph);
  if (directives.length === 0) return [];

  const groups = groupDirectivesByScope(directives);
  const rules: ScopedRule[] = [];

  for (const [scope, scopedDirectives] of groups) {
    if (scope === null) continue;
    if (scopedDirectives.length < MIN_DIRECTIVES) continue;

    const body = renderScopedRuleBody(scopedDirectives);
    if (body.length > MAX_CHARS) {
      // Take only directives that fit
      const trimmed = trimToCharBudget(scopedDirectives, MAX_CHARS);
      if (trimmed.length < MIN_DIRECTIVES) continue;
      const trimmedBody = renderScopedRuleBody(trimmed);
      rules.push({
        filename: scopeToFilename(scope),
        scope,
        paths: [`${scope}/**`],
        body: trimmedBody,
      });
    } else {
      rules.push({
        filename: scopeToFilename(scope),
        scope,
        paths: [`${scope}/**`],
        body,
      });
    }
  }

  return rules;
}

/** Render a scoped rule file as paths: frontmatter + markdown body. */
export function renderScopedRule(rule: ScopedRule): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`paths: ${JSON.stringify(rule.paths)}`);
  lines.push("---");
  lines.push("");
  lines.push(rule.body);
  lines.push("");
  return lines.join("\n");
}

/**
 * Get directives that should remain in the main file (global + under-threshold scopes).
 */
export function getGlobalDirectives(directives: string[], scopedMap: Map<string | null, ScopedDirective[]>): string[] {
  // Collect texts of directives that moved to scoped files
  const scopedTexts = new Set<string>();
  for (const [scope, items] of scopedMap) {
    if (scope === null) continue;
    if (items.length < MIN_DIRECTIVES) continue;
    for (const item of items) {
      scopedTexts.add(item.text);
    }
  }

  return directives.filter((d) => !scopedTexts.has(d));
}

function scopeToFilename(scope: string): string {
  return `clarte-${scope.replace(/\//g, "-")}.md`;
}

function renderScopedRuleBody(directives: ScopedDirective[]): string {
  const lines: string[] = [];
  lines.push("## Working Guidelines");
  lines.push("");
  for (const d of directives) {
    lines.push(`- ${d.text}`);
  }
  return lines.join("\n");
}

function trimToCharBudget(directives: ScopedDirective[], budget: number): ScopedDirective[] {
  const result: ScopedDirective[] = [];
  let size = "## Working Guidelines\n\n".length;
  for (const d of directives) {
    const lineSize = `- ${d.text}\n`.length;
    if (size + lineSize > budget) break;
    result.push(d);
    size += lineSize;
  }
  return result;
}
