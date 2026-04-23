/**
 * @file logger.mjs
 * Structured logging and exit code helpers.
 *
 * - All log output goes to stderr so stdout stays clean for JSON context output.
 * - Human-readable format by default; NDJSON when --json-logs flag is set.
 */

import process from "node:process";

export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  PARSE_ERROR: 1,
  LANGUAGE_ERROR: 2,
  IO_ERROR: 3,
});

let _jsonLogs = false;
let _verbose = false;

/**
 * Configure the logger for the current run.
 * Call once at startup before any log() calls.
 *
 * @param {{jsonLogs?: boolean, verbose?: boolean}} opts
 */
export function configureLogger(opts = {}) {
  _jsonLogs = Boolean(opts.jsonLogs);
  _verbose = Boolean(opts.verbose);
}

/**
 * Write a structured log entry to stderr.
 *
 * @param {'info'|'warn'|'error'} level
 * @param {string} message
 * @param {Record<string, unknown>} [fields]
 */
export function log(level, message, fields = {}) {
  if (level === "info" && !_verbose && !fields.__always) {
    return;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  delete entry.__always;

  if (_jsonLogs) {
    process.stderr.write(JSON.stringify(entry) + "\n");
  } else {
    const prefix = level === "error" ? "[ERROR]" : level === "warn" ? "[WARN]" : "[INFO]";
    const extras = Object.entries(fields)
      .filter(([k]) => k !== "__always")
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
      .join("\n");
    process.stderr.write(`${prefix} ${message}${extras ? "\n" + extras : ""}\n`);
  }
}

/**
 * Always log (regardless of verbose mode). Used for top-level progress milestones.
 */
export function logAlways(level, message, fields = {}) {
  log(level, message, { ...fields, __always: true });
}

/**
 * Write a structured error to stderr and exit the process with the given code.
 *
 * @param {number} code - Exit code from EXIT_CODES
 * @param {string} message - Short error summary
 * @param {string} cause - Specific root cause
 * @param {string} suggestion - Actionable fix suggestion
 * @param {string} [workspace] - Workspace path for context
 */
export function exitWithError(code, message, cause, suggestion, workspace) {
  if (_jsonLogs) {
    process.stderr.write(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message,
      cause,
      suggestion,
      workspace: workspace || null,
      exitCode: code,
    }) + "\n");
  } else {
    process.stderr.write(`[ERROR] ${message}\n`);
    process.stderr.write(`  Cause: ${cause}\n`);
    process.stderr.write(`  Suggestion: ${suggestion}\n`);
    if (workspace) {
      process.stderr.write(`  Workspace: ${workspace}\n`);
    }
  }
  process.exit(code);
}
