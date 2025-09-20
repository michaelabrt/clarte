import pc from "picocolors";

// ── Environment detection ────────────────────────────────────────────────────

const isTTY = !!process.stdout.isTTY;
const noColor = !!process.env.NO_COLOR;

/**
 * Detect 24-bit true color support.
 * Checks COLORTERM env (common in modern terminals) and falls back
 * to TERM containing "256color" as a proxy for likely truecolor support.
 */
const trueColor =
  !noColor &&
  isTTY &&
  (process.env.COLORTERM === "truecolor" ||
    process.env.COLORTERM === "24bit" ||
    (process.env.TERM ?? "").includes("256color"));

// ── 24-bit ANSI helpers ──────────────────────────────────────────────────────

function rgb(r: number, g: number, b: number): (text: string) => string {
  if (noColor || !isTTY) return (t) => t;
  if (!trueColor) {
    // Fallback: return identity, caller maps to picocolors fallback
    return (t) => t;
  }
  const open = `\x1b[38;2;${r};${g};${b}m`;
  const close = "\x1b[39m";
  return (text: string) => `${open}${text}${close}`;
}

// ── Palette ──────────────────────────────────────────────────────────────────

const palette = {
  brand: rgb(122, 162, 247),   // #7aa2f7
  accent: rgb(137, 180, 250),  // #89b4fa
  muted: rgb(84, 92, 126),     // #545c7e
  success: rgb(125, 207, 255), // #7dcfff
  warn: rgb(178, 174, 166),    // #b2aea6 (cool stone, no orange)
  error: rgb(219, 75, 75),     // #db4b4b
};

// ── Fallback mapping (basic ANSI via picocolors) ─────────────────────────────

const fallback = {
  brand: pc.blue,
  accent: pc.cyan,
  muted: pc.dim,
  success: pc.green,
  warn: pc.yellow,
  error: pc.red,
};

function pick(key: keyof typeof palette): (text: string) => string {
  if (noColor || !isTTY) return (t) => t;
  return trueColor ? palette[key] : fallback[key];
}

// ── Gradient ─────────────────────────────────────────────────────────────────

type RGB = [number, number, number];

/**
 * Apply a per-character color gradient across `text`.
 * Falls back to `fallbackFn` on non-truecolor terminals.
 */
export function gradient(
  text: string,
  from: RGB,
  to: RGB,
  fallbackFn?: (text: string) => string,
): string {
  if (noColor || !isTTY) return text;
  if (!trueColor) return fallbackFn ? fallbackFn(text) : text;

  const len = text.length;
  if (len === 0) return text;
  if (len === 1) return `\x1b[38;2;${from[0]};${from[1]};${from[2]}m${text}\x1b[39m`;

  let result = "";
  for (let i = 0; i < len; i++) {
    const ratio = i / (len - 1);
    const r = Math.round(from[0] + (to[0] - from[0]) * ratio);
    const g = Math.round(from[1] + (to[1] - from[1]) * ratio);
    const b = Math.round(from[2] + (to[2] - from[2]) * ratio);
    result += `\x1b[38;2;${r};${g};${b}m${text[i]}`;
  }
  return result + "\x1b[39m";
}

// ── Exported theme ───────────────────────────────────────────────────────────

export const theme = {
  brand: (text: string) => pick("brand")(text),
  accent: (text: string) => pick("accent")(text),
  muted: (text: string) => pick("muted")(text),
  success: (text: string) => pick("success")(text),
  warn: (text: string) => pick("warn")(text),
  error: (text: string) => pick("error")(text),

  bold: (text: string) => (noColor || !isTTY ? text : pc.bold(text)),
  brandBold: (text: string) => pick("brand")(noColor || !isTTY ? text : pc.bold(text)),
  accentBold: (text: string) => pick("accent")(noColor || !isTTY ? text : pc.bold(text)),

  /** Styled checkmark */
  check: () => pick("success")("✓"),
};
