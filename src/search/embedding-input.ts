/**
 * Construct text inputs for embedding generation.
 *
 * Per-symbol format: "{kind} {file_path} {symbol_name} {body_excerpt_first_200_tokens}"
 * The combination of structural metadata + code tokens produces embeddings that
 * capture both semantic meaning and structural context.
 */

const MAX_SYMBOL_BODY_TOKENS = 200;

/**
 * Build the embedding input string for a single symbol.
 * Includes kind label, file path (directory context), symbol name and body excerpt.
 */
export function buildSymbolInput(kind: string, filePath: string, name: string, bodyTokens: string | null): string {
  const parts = [kind, filePath, name];
  if (bodyTokens) {
    const tokens = bodyTokens.split(/\s+/).slice(0, MAX_SYMBOL_BODY_TOKENS);
    parts.push(tokens.join(" "));
  }
  return parts.join(" ");
}
