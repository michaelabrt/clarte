import { isTTY, noColor, trueColor, getShimmerColors } from "./theme.js";
import type { RGB } from "./theme.js";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** Shimmer window half-width (characters affected on each side of center) */
const SHIMMER_WIDTH = 5;

/** Milliseconds between frames */
const FRAME_INTERVAL = 75;

/** Icon advances every 3 render frames (~225ms per icon frame) */
const ICON_FRAME_DIVISOR = 3;

/** Breathing star cycle */
const SUN_FRAMES = [
  " \u273b ", //  ✻
  " \u2732 ", //  ✲
  " \u273d ", //  ✽
  " \u274b ", //  ❋
  " \u273d ", //  ✽
];

/**
 * Render a single shimmer frame: each character is colored by its distance
 * from the moving cursor position.  Characters at the cursor get the
 * highlight color, those far away get the base color, with smooth
 * interpolation in between.
 */
function renderShimmerFrame(text: string, cursorPos: number, base: RGB, highlight: RGB, width: number): string {
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
function renderSunIcon(frameIndex: number, renderFrame: number, base: RGB, highlight: RGB): string {
  const icon = SUN_FRAMES[frameIndex];
  if (!trueColor) return icon;

  // Smooth sine-wave brightness cycle
  const brightness = (Math.sin(renderFrame * 0.15) + 1) / 2; // 0..1

  const r = Math.round(base[0] + (highlight[0] - base[0]) * brightness);
  const g = Math.round(base[1] + (highlight[1] - base[1]) * brightness);
  const b = Math.round(base[2] + (highlight[2] - base[2]) * brightness);
  return `\x1b[38;2;${r};${g};${b}m${icon}\x1b[39m`;
}

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
      stop: () => {
        process.stdout.write("\x1b[A\x1b[2K");
      },
      message: () => {},
    };
  }

  const shimmerColors = getShimmerColors();
  const base = options?.base ?? shimmerColors.base;
  const highlight = options?.highlight ?? shimmerColors.highlight;
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
    const icon = renderSunIcon(iconIdx, renderFrame, base, highlight);
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
