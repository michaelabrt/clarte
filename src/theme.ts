import pc from "picocolors";

// ── Environment detection ────────────────────────────────────────────────────

export const isTTY = !!process.stdout.isTTY;
export const noColor = !!process.env.NO_COLOR;

/**
 * Detect terminal background from the COLORFGBG env var.
 * Format: "fg;bg" (some terminals include a middle value: "fg;extra;bg").
 * Standard ANSI color indices 0-6 are dark, 7-15 are light.
 * Returns null if the variable is absent or unparseable.
 */
export function detectTerminalBackground(): "dark" | "light" | null {
  const raw = process.env.COLORFGBG;
  if (!raw) return null;
  const parts = raw.split(";");
  const bg = parseInt(parts[parts.length - 1], 10);
  if (Number.isNaN(bg)) return null;
  return bg >= 7 ? "light" : "dark";
}

/**
 * Detect 24-bit true color support.
 * Checks COLORTERM env (common in modern terminals), WT_SESSION
 * (Windows Terminal), known TERM_PROGRAM values, and falls back
 * to TERM containing "256color" as a proxy for likely truecolor support.
 */
export const trueColor =
  !noColor &&
  isTTY &&
  (process.env.COLORTERM === "truecolor" ||
    process.env.COLORTERM === "24bit" ||
    !!process.env.WT_SESSION ||
    ["iTerm.app", "WezTerm", "Hyper", "vscode"].includes(process.env.TERM_PROGRAM ?? "") ||
    (process.env.TERM ?? "").includes("256color"));

// ── 24-bit ANSI helpers ──────────────────────────────────────────────────────

export type RGB = [number, number, number];

type ColorMode = "dark" | "light";

// ── Palettes ─────────────────────────────────────────────────────────────────
//
// Each palette defines raw RGB triples for every semantic role.
// Dark: light text on dark background (current aesthetic)
// Light: dark text on light background (inverted brightness, same accent family)
//

interface PaletteRGB {
  boneWhite: RGB;
  offWhite: RGB;
  brand: RGB;
  warm: RGB;
  muted: RGB;
  error: RGB;
  ghostWhite: RGB;
}

const darkPalette: PaletteRGB = {
  boneWhite: [240, 238, 233],
  offWhite: [200, 200, 204],
  brand: [255, 217, 171],
  warm: [222, 200, 175],
  muted: [190, 186, 178],
  error: [196, 72, 96],
  ghostWhite: [158, 156, 150],
};

const lightPalette: PaletteRGB = {
  boneWhite: [50, 50, 55],
  offWhite: [80, 80, 86],
  brand: [170, 120, 40],
  warm: [160, 110, 30],
  muted: [140, 140, 146],
  error: [140, 35, 50],
  ghostWhite: [180, 180, 186],
};

// ── Mutable state ────────────────────────────────────────────────────────────

let currentPalette: PaletteRGB = darkPalette;
const RESET_FG = "\x1b[39m";

function rgb(r: number, g: number, b: number): (text: string) => string {
  if (noColor || !isTTY) return (t) => t;
  if (!trueColor) return (t) => t;
  const open = `\x1b[38;2;${r};${g};${b}m`;
  const [cr, cg, cb] = currentPalette.offWhite;
  const close = `\x1b[38;2;${cr};${cg};${cb}m`;
  return (text: string) => `${open}${text}${close}`;
}

/** Raw ANSI helper for clack patching (closes with terminal default). */
function rgbAnsi(r: number, g: number, b: number): (text: string) => string {
  const open = `\x1b[38;2;${r};${g};${b}m`;
  const close = "\x1b[39m";
  return (text: string) => `${open}${text}${close}`;
}

// ── Fallback mapping (basic ANSI via picocolors) ─────────────────────────────

const fallback = {
  boneWhite: pc.white,
  offWhite: pc.white,
  warm: pc.yellow,
  brand: pc.yellow,
  accent: pc.yellow,
  muted: pc.dim,
  error: pc.red,
};

type PaletteKey = "boneWhite" | "offWhite" | "warm" | "brand" | "accent" | "muted" | "error";

function pick(key: PaletteKey): (text: string) => string {
  if (noColor || !isTTY) return (t) => t;
  if (!trueColor) return fallback[key];
  // Build fresh closure from current palette
  const colorKey = key === "accent" ? "brand" : key;
  const [r, g, b] = currentPalette[colorKey];
  return rgb(r, g, b);
}

// ── Gradient ─────────────────────────────────────────────────────────────────

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
  const [cr, cg, cb] = currentPalette.offWhite;
  const close = `\x1b[38;2;${cr};${cg};${cb}m`;
  if (len === 1) return `\x1b[38;2;${from[0]};${from[1]};${from[2]}m${text}${close}`;

  let result = "";
  for (let i = 0; i < len; i++) {
    const ratio = i / (len - 1);
    const r = Math.round(from[0] + (to[0] - from[0]) * ratio);
    const g = Math.round(from[1] + (to[1] - from[1]) * ratio);
    const b = Math.round(from[2] + (to[2] - from[2]) * ratio);
    result += `\x1b[38;2;${r};${g};${b}m${text[i]}`;
  }
  return result + close;
}

// ── Theme init ───────────────────────────────────────────────────────────────

/**
 * Initialize the theme for the given color mode.
 * Sets the active palette. Call patchPicocolors() separately
 * to override picocolors for @clack/prompts rendering.
 */
export function initTheme(mode: ColorMode): void {
  currentPalette = mode === "light" ? lightPalette : darkPalette;
}

// ── Picocolors patching ─────────────────────────────────────────────────────

let savedPicocolors: Record<string, unknown> | null = null;

const PATCH_KEYS = ["green", "cyan", "yellow", "red", "blue", "magenta", "white", "reset", "gray", "dim"] as const;

/**
 * Monkey-patch picocolors with the current palette so @clack/prompts
 * renders in our theme. Must be called after initTheme().
 */
export function patchPicocolors(): void {
  if (noColor || !isTTY) return;

  const obj = pc as unknown as Record<string, unknown>;

  // Save originals (only once; nested patches keep the first save)
  if (!savedPicocolors) {
    savedPicocolors = {};
    for (const key of PATCH_KEYS) {
      savedPicocolors[key] = obj[key];
    }
  }

  const p = currentPalette;
  const copper = rgbAnsi(...p.brand);
  const wineRed = rgbAnsi(...p.error);
  const boneWhite = rgbAnsi(...p.boneWhite);
  const ghostWhite = rgbAnsi(...p.ghostWhite);

  obj.green = copper;
  obj.cyan = copper;
  obj.yellow = copper;
  obj.red = wineRed;
  obj.blue = copper;
  obj.magenta = copper;
  obj.white = boneWhite;
  obj.reset = boneWhite;
  obj.gray = ghostWhite;
  obj.dim = boneWhite;
}

/**
 * Restore picocolors to its original (unpatched) state.
 */
export function unpatchPicocolors(): void {
  if (!savedPicocolors) return;
  const obj = pc as unknown as Record<string, unknown>;
  for (const key of PATCH_KEYS) {
    obj[key] = savedPicocolors[key];
  }
  savedPicocolors = null;
}

/**
 * Emit a standard foreground reset so the terminal returns to its
 * default color after our output. Call once at process exit.
 */
export function resetTerminalColors(): void {
  if (!noColor && isTTY) {
    process.stdout.write(RESET_FG);
  }
}

// ── Shimmer color accessor ───────────────────────────────────────────────────

/**
 * Return the current palette's shimmer base and highlight colors.
 * Used by animations.ts to avoid hardcoded RGB values.
 */
export function getShimmerColors(): { base: RGB; highlight: RGB } {
  return {
    base: currentPalette.offWhite,
    highlight: currentPalette.brand,
  };
}

/**
 * Return the current palette's gradient bar colors for summary charts.
 */
export function getGradientBarColors(): { from: RGB; to: RGB } {
  if (currentPalette === lightPalette) {
    return { from: [160, 130, 90], to: [190, 160, 120] };
  }
  return { from: [220, 198, 185], to: [235, 218, 208] };
}

// ── Exported theme ───────────────────────────────────────────────────────────

export const theme = {
  /** Off-white -- regular body text (also auto-applied after any themed segment) */
  text: (text: string) => pick("offWhite")(text),
  /** Dawn amber -- warning highlight */
  warm: (text: string) => pick("warm")(text),
  /** Warm gold -- accent highlights, checkmarks */
  brand: (text: string) => pick("brand")(text),
  accent: (text: string) => pick("accent")(text),
  /** Warm gray -- secondary/dim text */
  muted: (text: string) => pick("muted")(text),
  /** Wine red -- errors only */
  error: (text: string) => pick("error")(text),

  /** Off-white -- alias for text */
  soft: (text: string) => pick("offWhite")(text),

  bold: (text: string) => (noColor || !isTTY ? text : pc.bold(text)),
  /** Bone white + bold -- emphasis, section headers */
  textBold: (text: string) => pick("boneWhite")(noColor || !isTTY ? text : pc.bold(text)),
  brandBold: (text: string) => pick("brand")(noColor || !isTTY ? text : pc.bold(text)),

  /** Success/positive indicator -- maps to warm gold */
  success: (text: string) => pick("brand")(text),
  /** Warning/caution indicator -- maps to dawn amber */
  warn: (text: string) => pick("warm")(text),

  accentBold: (text: string) => pick("accent")(noColor || !isTTY ? text : pc.bold(text)),
  /** Off-white + bold -- file paths, secondary emphasis */
  softBold: (text: string) => pick("offWhite")(noColor || !isTTY ? text : pc.bold(text)),

  /** Styled checkmark in warm gold */
  check: () => pick("brand")("\u2713"),
};
