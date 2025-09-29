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

function rgbAnsi(r: number, g: number, b: number): (text: string) => string {
  const open = `\x1b[38;2;${r};${g};${b}m`;
  const close = "\x1b[39m";
  return (text: string) => `${open}${text}${close}`;
}

// ── Palette ──────────────────────────────────────────────────────────────────

const palette = {
  text: rgb(235, 233, 228),    // bone white -- clean off-white
  warm: rgb(224, 220, 210),    // light gold -- warm highlight with body
  brand: rgb(233, 206, 161),   // warm gold (#E9CEA1)
  accent: rgb(233, 206, 161),  // warm gold (same as brand)
  muted: rgb(202, 196, 178),   // light champagne (#CAC4B2)
  error: rgb(134, 38, 51),     // wine red
};

// ── Fallback mapping (basic ANSI via picocolors) ─────────────────────────────

const fallback = {
  text: pc.white,
  warm: pc.white,
  brand: pc.yellow,
  accent: pc.yellow,
  muted: pc.dim,
  error: pc.red,
};

function pick(key: keyof typeof palette): (text: string) => string {
  if (noColor || !isTTY) return (t) => t;
  return trueColor ? palette[key] : fallback[key];
}

// ── Gradient ─────────────────────────────────────────────────────────────────

export type RGB = [number, number, number];

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

// ── Patch @clack/prompts colors ──────────────────────────────────────────────

/**
 * Monkey-patch picocolors singleton so @clack/prompts renders
 * in our gold/wine-red palette instead of default terminal colors.
 */
export function patchClackColors(): void {
  if (noColor || !isTTY) return;

  const gold = rgbAnsi(233, 206, 161);
  const wineRed = rgbAnsi(134, 38, 51);
  const boneWhite = rgbAnsi(235, 233, 228);
  const champagne = rgbAnsi(202, 196, 178);

  const obj = pc as unknown as Record<string, unknown>;
  obj.green = gold;
  obj.cyan = gold;
  obj.yellow = gold;
  obj.red = wineRed;
  obj.blue = gold;
  obj.magenta = gold;
  obj.white = boneWhite;
  obj.reset = boneWhite;   // clack wraps note titles in pc.reset()
  const boneWhiteSoft = rgbAnsi(202, 199, 192);
  obj.gray = boneWhiteSoft;  // bone white soft for bars and borders
  obj.dim = boneWhiteSoft;   // clack uses pc.dim for submitted values and separators
}

// ── Exported theme ───────────────────────────────────────────────────────────

export const theme = {
  /** Bone white -- primary text color */
  text: (text: string) => pick("text")(text),
  /** Light gold -- warm highlight with substance */
  warm: (text: string) => pick("warm")(text),
  /** Premium gold -- accent highlights, checkmarks */
  brand: (text: string) => pick("brand")(text),
  accent: (text: string) => pick("accent")(text),
  /** Warm gray -- secondary/dim text */
  muted: (text: string) => pick("muted")(text),
  /** Wine red -- errors only */
  error: (text: string) => pick("error")(text),

  /** Soft white -- slightly muted bone white for table content, option values */
  soft: (text: string) => noColor || !isTTY ? text : trueColor ? `\x1b[38;2;202;199;192m${text}\x1b[39m` : pc.white(text),

  bold: (text: string) => (noColor || !isTTY ? text : pc.bold(text)),
  /** Bone white + bold -- section headers */
  textBold: (text: string) => pick("text")(noColor || !isTTY ? text : pc.bold(text)),
  brandBold: (text: string) => pick("brand")(noColor || !isTTY ? text : pc.bold(text)),

  /** Success/positive indicator -- maps to gold in warm palette */
  success: (text: string) => pick("brand")(text),
  /** Warning/caution indicator -- maps to warm tone */
  warn: (text: string) => pick("warm")(text),

  accentBold: (text: string) => pick("accent")(noColor || !isTTY ? text : pc.bold(text)),

  /** Styled checkmark in gold */
  check: () => pick("brand")("\u2713"),
};
