/**
 * Format an imperative edit-target directive for append-system-prompt injection.
 * Returns empty string if no targets (smart silence).
 */
export function formatEditDirective(targets: string[]): string {
  if (targets.length === 0) return "";

  const fileList = targets.map((t) => `\`${t}\``).join(", ");
  return `Likely edit targets based on dependency analysis: ${fileList}. Start editing after confirming the relevant code.`;
}
