/**
 * Base error class for all clarte-specific errors.
 * Carries an exit code so the top-level handler can exit cleanly.
 */
export class ClarteError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "ClarteError";
    this.exitCode = exitCode;
  }
}

/** Standard exit codes used across the CLI */
export const ExitCode = {
  SUCCESS: 0,
  FAILURE: 1,
  MISSING: 2,
  TIMEOUT: 3,
  PARSE_ERROR: 4,
} as const;
