/**
 * @file detector.mjs
 * Language auto-detection via indicator-file scoring.
 *
 * Scanning depth: workspace root (depth 0) + immediate subdirectories (depth 1).
 * Scoring: higher score wins; ties cause an error (ambiguous workspace).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { IGNORED_DIR_NAMES } from "./strategies/base.mjs";

/** @type {Record<string, {language: string, score: number}>} */
const INDICATOR_SCORES = {
  "pom.xml":          { language: "java-spring", score: 10 },
  "build.gradle":     { language: "java-spring", score: 10 },
  "build.gradle.kts": { language: "java-spring", score: 10 },
  "package.json":     { language: "nodejs",      score: 10 },
  "pyproject.toml":   { language: "python",      score: 10 },
  "setup.py":         { language: "python",      score: 8  },
  "setup.cfg":        { language: "python",      score: 8  },
  "requirements.txt": { language: "python",      score: 6  },
};

export const SUPPORTED_LANGUAGES = ["java-spring", "nodejs", "python"];

/**
 * Detect the primary language of a workspace.
 *
 * @param {string} rootDir - Absolute path to the workspace root directory.
 * @param {{language?: string}} [opts]
 *   opts.language - If provided, skip detection and return this language directly.
 * @returns {Promise<{language: string, detectionSource: string, detectionScore: number}>}
 * @throws {{code: number, message: string, cause: string, suggestion: string}} on failure
 */
export async function detectLanguage(rootDir, opts = {}) {
  if (opts.language) {
    if (!SUPPORTED_LANGUAGES.includes(opts.language)) {
      throw {
        code: 2,
        message: "Unsupported language specified",
        cause: `"${opts.language}" is not a supported language`,
        suggestion: `Use one of: ${SUPPORTED_LANGUAGES.join(", ")}`,
        workspace: rootDir,
      };
    }
    return { language: opts.language, detectionSource: "--language flag", detectionScore: 100 };
  }

  /** @type {Map<string, {score: number, file: string}>} */
  const languageScores = new Map();

  async function scoreDir(dirPath) {
    let dirents;
    try {
      dirents = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (!dirent.isFile()) {
        continue;
      }
      const indicator = INDICATOR_SCORES[dirent.name];
      if (!indicator) {
        continue;
      }
      const existing = languageScores.get(indicator.language);
      const newScore = (existing?.score || 0) + indicator.score;
      languageScores.set(indicator.language, {
        score: newScore,
        file: existing?.file || dirent.name,
      });
    }
  }

  // Depth 0: workspace root
  await scoreDir(rootDir);

  // Depth 1: immediate subdirectories (for monorepos)
  let rootDirents;
  try {
    rootDirents = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    rootDirents = [];
  }
  for (const dirent of rootDirents) {
    if (dirent.isDirectory() && !IGNORED_DIR_NAMES.has(dirent.name)) {
      await scoreDir(path.join(rootDir, dirent.name));
    }
  }

  if (languageScores.size === 0) {
    throw {
      code: 2,
      message: "Language detection failed",
      cause: `No indicator files found (${Object.keys(INDICATOR_SCORES).join(", ")})`,
      suggestion: `Run with --language <${SUPPORTED_LANGUAGES.join("|")}> to specify manually`,
      workspace: rootDir,
    };
  }

  const sorted = Array.from(languageScores.entries()).sort((a, b) => b[1].score - a[1].score);

  if (sorted.length > 1 && sorted[0][1].score === sorted[1][1].score) {
    throw {
      code: 2,
      message: "Language detection is ambiguous",
      cause: `Multiple languages detected with equal confidence: ${sorted.map(([l]) => l).join(", ")}`,
      suggestion: `Run with --language <${SUPPORTED_LANGUAGES.join("|")}> to specify manually`,
      workspace: rootDir,
    };
  }

  const [language, { score: detectionScore, file: detectionSource }] = sorted[0];
  return { language, detectionSource, detectionScore };
}
