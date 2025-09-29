import { theme as t } from "./theme.js";
import type { RGB } from "./theme.js";

// ── Environment ─────────────────────────────────────────────────────────────

const isTTY = !!process.stdout.isTTY;
const noColor = !!process.env.NO_COLOR;
const trueColor =
  !noColor &&
  isTTY &&
  (process.env.COLORTERM === "truecolor" ||
    process.env.COLORTERM === "24bit" ||
    (process.env.TERM ?? "").includes("256color"));

// ── Constants ───────────────────────────────────────────────────────────────

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** Default colors: bone white base, premium gold shimmer highlight */
const DEFAULT_BASE: RGB = [235, 233, 228];       // bone white (matches theme)
const DEFAULT_HIGHLIGHT: RGB = [233, 206, 161];   // warm gold



/** Shimmer window half-width (characters affected on each side of center) */
const SHIMMER_WIDTH = 5;

/** Milliseconds between frames */
const FRAME_INTERVAL = 75;

/** Icon advances every 3 render frames (~225ms per icon frame) */
const ICON_FRAME_DIVISOR = 3;

// ── Sun icon frames ─────────────────────────────────────────────────────────

/** Breathing star cycle */
const SUN_FRAMES = [
  " \u273b ",  //  ✻
  " \u2732 ",  //  ✲
  " \u273d ",  //  ✽
  " \u274b ",  //  ❋
  " \u273d ",  //  ✽
];

// ── Shimmer core ────────────────────────────────────────────────────────────

/**
 * Render a single shimmer frame: each character is colored by its distance
 * from the moving cursor position.  Characters at the cursor get the
 * highlight color, those far away get the base color, with smooth
 * interpolation in between.
 */
function renderShimmerFrame(
  text: string,
  cursorPos: number,
  base: RGB,
  highlight: RGB,
  width: number,
): string {
  if (!trueColor) return text;

  let result = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " ") {
      result += ch;
      continue;
    }

    const distance = Math.abs(i - cursorPos);
    if (distance >= width) {
      result += `\x1b[38;2;${base[0]};${base[1]};${base[2]}m${ch}`;
    } else {
      // Smooth ease: cosine interpolation for elegant falloff
      const t = Math.cos((distance / width) * (Math.PI / 2));
      const r = Math.round(base[0] + (highlight[0] - base[0]) * t);
      const g = Math.round(base[1] + (highlight[1] - base[1]) * t);
      const b = Math.round(base[2] + (highlight[2] - base[2]) * t);
      result += `\x1b[38;2;${r};${g};${b}m${ch}`;
    }
  }
  return result + "\x1b[39m";
}

/** Render the icon with a smooth brightness cycle. */
function renderSunIcon(frameIndex: number, renderFrame: number): string {
  const icon = SUN_FRAMES[frameIndex];
  if (!trueColor) return icon;

  // Smooth sine-wave brightness cycle
  const brightness = (Math.sin(renderFrame * 0.15) + 1) / 2; // 0..1

  const r = Math.round(DEFAULT_BASE[0] + (DEFAULT_HIGHLIGHT[0] - DEFAULT_BASE[0]) * brightness);
  const g = Math.round(DEFAULT_BASE[1] + (DEFAULT_HIGHLIGHT[1] - DEFAULT_BASE[1]) * brightness);
  const b = Math.round(DEFAULT_BASE[2] + (DEFAULT_HIGHLIGHT[2] - DEFAULT_BASE[2]) * brightness);
  return `\x1b[38;2;${r};${g};${b}m${icon}\x1b[39m`;
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface ShimmerHandle {
  /** Stop the shimmer and clear the line */
  stop: () => void;
  /** Update the shimmer text mid-animation */
  message: (text: string) => void;
}

/**
 * Start a shimmer animation on a line of text.
 * The highlight sweeps left->right->left continuously.
 * A pulsating star icon cycles on the left.
 * Returns a handle to stop it or update the text.
 */
export function startShimmer(
  text: string,
  options?: {
    base?: RGB;
    highlight?: RGB;
    width?: number;
    indent?: string;
  },
): ShimmerHandle {
  if (!isTTY || noColor) {
    // Non-interactive: just print the text and return a no-op handle
    process.stdout.write(`${options?.indent ?? "    "}${text}\n`);
    return {
      stop: () => { process.stdout.write("\x1b[A\x1b[2K"); },
      message: () => {},
    };
  }

  const base = options?.base ?? DEFAULT_BASE;
  const highlight = options?.highlight ?? DEFAULT_HIGHLIGHT;
  const width = options?.width ?? SHIMMER_WIDTH;
  const indent = options?.indent ?? "  ";

  let currentText = text;
  let pos = 0;
  let direction = 1; // 1 = right, -1 = left
  let renderFrame = 0;

  process.stdout.write(HIDE_CURSOR);

  const timer = setInterval(() => {
    const len = currentText.length;
    const iconIdx = Math.floor(renderFrame / ICON_FRAME_DIVISOR) % SUN_FRAMES.length;
    const icon = renderSunIcon(iconIdx, renderFrame);
    const frame = renderShimmerFrame(currentText, pos, base, highlight, width);
    process.stdout.write(`\r${indent}${icon} ${frame}`);

    pos += direction;
    if (pos >= len + width) {
      direction = -1;
    } else if (pos <= -width) {
      direction = 1;
    }
    renderFrame++;
  }, FRAME_INTERVAL);

  return {
    stop() {
      clearInterval(timer);
      // Clear the line and restore cursor
      process.stdout.write(`\r\x1b[2K${SHOW_CURSOR}`);
    },
    message(newText: string) {
      currentText = newText;
      // Reset shimmer position when text changes to avoid out-of-bounds
      pos = 0;
      direction = 1;
    },
  };
}

/**
 * Run a shimmer animation while an async operation completes.
 * The shimmer stops automatically when the work resolves.
 */
export async function withShimmer<T>(
  text: string,
  work: Promise<T>,
  options?: {
    base?: RGB;
    highlight?: RGB;
    width?: number;
    indent?: string;
  },
): Promise<T> {
  const shimmer = startShimmer(text, options);
  try {
    return await work;
  } finally {
    shimmer.stop();
  }
}

// ── Frame-based animations ──────────────────────────────────────────────────

function clearLine(): string {
  return "\x1b[A\x1b[2K";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Render single-line frames, each replacing the previous.
 */
async function renderFrames(
  frames: string[],
  intervalMs: number,
): Promise<void> {
  if (!isTTY || noColor) return;

  process.stdout.write(HIDE_CURSOR);
  try {
    for (let i = 0; i < frames.length; i++) {
      if (i > 0) process.stdout.write(clearLine());
      process.stdout.write(frames[i] + "\n");
      if (i < frames.length - 1) await sleep(intervalMs);
    }
  } finally {
    // Clear final frame
    process.stdout.write(clearLine());
    process.stdout.write(SHOW_CURSOR);
  }
}

const ANIM_INTERVAL = 80;
const ANIM_WIDTH = 24;

/**
 * Graph build: line extending left to right.
 */
export async function animateGraphBuild(
  _fileCount: number,
  _edgeCount: number,
): Promise<void> {
  const frames: string[] = [];
  const steps = 5;

  for (let n = 1; n <= steps; n++) {
    const filled = Math.round((n / steps) * ANIM_WIDTH);
    const remaining = ANIM_WIDTH - filled;
    frames.push(`    ${t.brand("\u2501".repeat(filled))}${t.muted("\u254c".repeat(remaining))}`);
  }

  await renderFrames(frames, ANIM_INTERVAL);
}

/**
 * PageRank: line extending from center outward.
 */
export async function animatePageRank(): Promise<void> {
  const frames: string[] = [];
  const steps = 4;

  for (let n = 1; n <= steps; n++) {
    const half = Math.round((n / steps) * (ANIM_WIDTH / 2));
    const pad = (ANIM_WIDTH / 2) - half;
    frames.push(`    ${t.muted("\u254c".repeat(pad))}${t.brand("\u2501".repeat(half * 2))}${t.muted("\u254c".repeat(pad))}`);
  }

  await renderFrames(frames, ANIM_INTERVAL);
}

/**
 * Cycle detection: sweep line, final frame colored by result.
 */
export async function animateCycleDetection(
  cycleCount: number,
): Promise<void> {
  const frames: string[] = [];
  const steps = 5;

  for (let n = 1; n <= steps; n++) {
    const filled = Math.round((n / steps) * ANIM_WIDTH);
    const remaining = ANIM_WIDTH - filled;
    frames.push(`    ${t.brand("\u2501".repeat(filled))}${remaining > 0 ? t.muted("\u254c".repeat(remaining)) : t.brand("\u25b8")}`);
  }

  const complete = "\u2501".repeat(ANIM_WIDTH) + "\u25b8";
  if (cycleCount > 0) {
    frames.push(`    ${t.warn(complete)}`);
  } else {
    frames.push(`    ${t.brand(complete)}`);
  }

  await renderFrames(frames, ANIM_INTERVAL);
}

/**
 * Layer stack: actual layer names appearing incrementally.
 */
export async function animateLayerStack(
  layerNames: string[],
): Promise<void> {
  if (layerNames.length === 0) return;

  const frames: string[] = [];
  for (let i = 1; i <= layerNames.length; i++) {
    const visible = layerNames.slice(0, i);
    frames.push(`    ${t.brand(visible.join(` ${t.muted("\u25b8")} `))}`);
  }

  await renderFrames(frames, ANIM_INTERVAL);
}

/**
 * Communities: scattered dashes coalescing into solid clusters.
 */
export async function animateCommunities(
  communityCount: number,
): Promise<void> {
  if (communityCount === 0) return;

  const count = Math.min(communityCount, 5);
  const frames: string[] = [];

  const scattered = Array.from({ length: count }, () => "\u254c\u254c\u254c").join("  ");
  frames.push(`    ${t.muted(scattered)}`);

  const partial = Array.from({ length: count }, () => "\u2501\u254c\u2501").join("  ");
  frames.push(`    ${t.brand(partial)}`);

  const solid = Array.from({ length: count }, () => "\u2501\u2501\u2501").join("  ");
  frames.push(`    ${t.brand(solid)}`);

  await renderFrames(frames, ANIM_INTERVAL);
}
