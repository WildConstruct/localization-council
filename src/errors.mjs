/**
 * Error types shared across modules. Kept dependency-free to avoid import cycles.
 */

/** Bad flags, unknown profiles/providers, or other input the caller must fix (exit 2). */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = 2;
  }
}
