/**
 * Unit tests for the language detector.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { detectLanguage, SUPPORTED_LANGUAGES } from "../../src/detector.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "../integration/fixtures");

// Helper: create a temp dir with specific files
async function makeTmpDir(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kg-detect-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content || "");
  }
  return dir;
}

describe("detectLanguage: explicit --language override", () => {
  it("returns the specified language without scanning", async () => {
    const dir = await makeTmpDir({});
    try {
      const result = await detectLanguage(dir, { language: "nodejs" });
      assert.equal(result.language, "nodejs");
      assert.equal(result.detectionSource, "--language flag");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("throws code 2 for unsupported language", async () => {
    const dir = await makeTmpDir({});
    try {
      await assert.rejects(
        () => detectLanguage(dir, { language: "ruby" }),
        (err) => {
          assert.equal(err.code, 2);
          return true;
        },
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("detectLanguage: auto-detection from fixtures", () => {
  it("detects Java Spring from pom.xml", async () => {
    const result = await detectLanguage(path.join(FIXTURES, "java-spring-workspace"));
    assert.equal(result.language, "java-spring");
  });

  it("detects Node.js from package.json", async () => {
    const result = await detectLanguage(path.join(FIXTURES, "nodejs-workspace"));
    assert.equal(result.language, "nodejs");
  });

  it("detects Python from pyproject.toml", async () => {
    const result = await detectLanguage(path.join(FIXTURES, "python-workspace"));
    assert.equal(result.language, "python");
  });
});

describe("detectLanguage: error conditions", () => {
  it("throws code 2 when no indicator files exist", async () => {
    const dir = await makeTmpDir({ "README.md": "# project" });
    try {
      await assert.rejects(
        () => detectLanguage(dir),
        (err) => {
          assert.equal(err.code, 2);
          assert.ok(err.message.toLowerCase().includes("detection failed") || err.message.toLowerCase().includes("language"));
          return true;
        },
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("includes suggestion in error", async () => {
    const dir = await makeTmpDir({});
    try {
      await assert.rejects(
        () => detectLanguage(dir),
        (err) => {
          assert.ok(typeof err.suggestion === "string");
          assert.ok(err.suggestion.length > 0);
          return true;
        },
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("SUPPORTED_LANGUAGES", () => {
  it("contains all three languages", () => {
    assert.ok(SUPPORTED_LANGUAGES.includes("java-spring"));
    assert.ok(SUPPORTED_LANGUAGES.includes("nodejs"));
    assert.ok(SUPPORTED_LANGUAGES.includes("python"));
  });
});
