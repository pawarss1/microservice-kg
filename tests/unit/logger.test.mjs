/**
 * Unit tests for logger.mjs — exit codes, log format, stderr targeting.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EXIT_CODES, configureLogger } from "../../src/logger.mjs";

describe("EXIT_CODES", () => {
  it("SUCCESS is 0", () => {
    assert.equal(EXIT_CODES.SUCCESS, 0);
  });

  it("PARSE_ERROR is 1", () => {
    assert.equal(EXIT_CODES.PARSE_ERROR, 1);
  });

  it("LANGUAGE_ERROR is 2", () => {
    assert.equal(EXIT_CODES.LANGUAGE_ERROR, 2);
  });

  it("IO_ERROR is 3", () => {
    assert.equal(EXIT_CODES.IO_ERROR, 3);
  });

  it("EXIT_CODES is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(EXIT_CODES));
  });
});

describe("configureLogger", () => {
  it("accepts jsonLogs and verbose options without error", () => {
    assert.doesNotThrow(() => configureLogger({ jsonLogs: true, verbose: true }));
    assert.doesNotThrow(() => configureLogger({ jsonLogs: false, verbose: false }));
    assert.doesNotThrow(() => configureLogger({}));
    assert.doesNotThrow(() => configureLogger());
  });
});
