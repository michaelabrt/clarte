/** Directory names to always ignore across import resolution, watch, and snapshot. */
export const IGNORE_DIRS = [
  "node_modules",
  "dist",
  "build",
  ".next",
  "target",
  "vendor",
  "__pycache__",
  "venv",
  ".venv",
  ".git",
  ".clarte",
] as const;

/** Glob patterns derived from IGNORE_DIRS, plus OS junk directories. */
export const IGNORE_GLOBS = [
  ...IGNORE_DIRS.map((d) => `**/${d}/**`),
  "**/.Trash/**",
  "**/Library/**",
];

/** Set variant for fast path-segment lookups (used by watch mode). */
export const IGNORE_DIRS_SET = new Set<string>(IGNORE_DIRS);
