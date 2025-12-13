import { execSync } from "node:child_process";

export interface GitExecOptions {
  cwd: string;
  timeout?: number;
  maxBuffer?: number;
}

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

export class GitError extends Error {
  readonly command: string;
  override readonly cause?: unknown;

  constructor(message: string, command: string, cause?: unknown) {
    super(message);
    this.name = "GitError";
    this.command = command;
    this.cause = cause;
  }
}

/**
 * Execute a git command and return stdout as a trimmed string.
 * Throws GitError on failure.
 */
export function gitExec(args: string[], opts: GitExecOptions): string {
  const command = `git ${args.join(" ")}`;
  try {
    return execSync(command, {
      cwd: opts.cwd,
      encoding: "utf-8",
      timeout: opts.timeout ?? DEFAULT_TIMEOUT,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GitError(message, command, err);
  }
}

/**
 * Execute a git command and return stdout, or null on any failure.
 */
export function gitExecSafe(args: string[], opts: GitExecOptions): string | null {
  try {
    return gitExec(args, opts);
  } catch {
    return null;
  }
}
