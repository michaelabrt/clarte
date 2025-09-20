import { theme as t } from "./theme.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const isTTY = !!process.stdout.isTTY;
const noColor = !!process.env.NO_COLOR;

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

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

// ── Shared constants ─────────────────────────────────────────────────────────

const INTERVAL = 80;
const WIDTH = 24;

// ── Animation Functions ──────────────────────────────────────────────────────

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
    const filled = Math.round((n / steps) * WIDTH);
    const remaining = WIDTH - filled;
    frames.push(`    ${t.brand("━".repeat(filled))}${t.muted("╌".repeat(remaining))}`);
  }

  await renderFrames(frames, INTERVAL);
}

/**
 * PageRank: line extending from center outward.
 */
export async function animatePageRank(): Promise<void> {
  const frames: string[] = [];
  const steps = 4;

  for (let n = 1; n <= steps; n++) {
    const half = Math.round((n / steps) * (WIDTH / 2));
    const pad = (WIDTH / 2) - half;
    frames.push(`    ${t.muted("╌".repeat(pad))}${t.brand("━".repeat(half * 2))}${t.muted("╌".repeat(pad))}`);
  }

  await renderFrames(frames, INTERVAL);
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
    const filled = Math.round((n / steps) * WIDTH);
    const remaining = WIDTH - filled;
    frames.push(`    ${t.brand("━".repeat(filled))}${remaining > 0 ? t.muted("╌".repeat(remaining)) : t.brand("▸")}`);
  }

  // Final frame: colored by result
  const complete = "━".repeat(WIDTH) + "▸";
  if (cycleCount > 0) {
    frames.push(`    ${t.warn(complete)}`);
  } else {
    frames.push(`    ${t.brand(complete)}`);
  }

  await renderFrames(frames, INTERVAL);
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
    frames.push(`    ${t.brand(visible.join(` ${t.muted("▸")} `))}`);
  }

  await renderFrames(frames, INTERVAL);
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

  // Frame 1: scattered dashes
  const scattered = Array.from({ length: count }, () => "╌╌╌").join("  ");
  frames.push(`    ${t.muted(scattered)}`);

  // Frame 2: partial grouping
  const partial = Array.from({ length: count }, () => "━╌━").join("  ");
  frames.push(`    ${t.brand(partial)}`);

  // Frame 3: solid clusters
  const solid = Array.from({ length: count }, () => "━━━").join("  ");
  frames.push(`    ${t.brand(solid)}`);

  await renderFrames(frames, INTERVAL);
}
