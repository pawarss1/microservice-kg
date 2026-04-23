/**
 * @file analyzer.mjs
 * Language-agnostic workspace context builder — thin orchestrator.
 *
 * Detects the workspace language, dispatches to the matching LanguageStrategy,
 * assembles the unified ContextOutput, and returns it to the caller.
 *
 * Adding a new language requires only:
 *   1. Create src/strategies/<lang>.mjs implementing the LanguageStrategy interface
 *   2. Register it in STRATEGIES below
 *   3. Add its indicator files to src/detector.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { buildServiceEdges, buildQueueEdges, renderSummary } from "./strategies/base.mjs";
import { detectLanguage } from "./detector.mjs";
import { log, logAlways, exitWithError, EXIT_CODES, configureLogger } from "./logger.mjs";

// ---------------------------------------------------------------------------
// Strategy registry — add new languages here
// ---------------------------------------------------------------------------
import * as javaSpring from "./strategies/java-spring.mjs";
import * as nodejs from "./strategies/nodejs.mjs";
import * as python from "./strategies/python.mjs";

const STRATEGIES = new Map([
  [javaSpring.id, javaSpring],
  [nodejs.id, nodejs],
  [python.id, python],
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a workspace and return the unified ContextOutput.
 *
 * @param {string} inputDir - Absolute path to the workspace root
 * @param {{language?: string, verbose?: boolean, jsonLogs?: boolean}} [opts]
 * @returns {Promise<Object>} ContextOutput
 */
export async function analyzeWorkspace(inputDir, opts = {}) {
  configureLogger({ verbose: opts.verbose, jsonLogs: opts.jsonLogs });

  const startTime = Date.now();

  // 1. Detect (or accept explicit) language
  let detection;
  try {
    detection = await detectLanguage(inputDir, { language: opts.language });
  } catch (err) {
    exitWithError(
      err.code || EXIT_CODES.LANGUAGE_ERROR,
      err.message || "Language detection failed",
      err.cause || "Unknown cause",
      err.suggestion || "Specify --language manually",
      inputDir,
    );
  }

  const { language, detectionSource, detectionScore } = detection;
  log("info", `Language detected: ${language}`, {
    detectionSource,
    detectionScore,
    workspace: inputDir,
  });

  // 2. Load strategy
  const strategy = STRATEGIES.get(language);
  if (!strategy) {
    exitWithError(
      EXIT_CODES.LANGUAGE_ERROR,
      `No strategy found for language "${language}"`,
      `"${language}" is registered in detector but has no corresponding strategy module`,
      `Supported languages: ${Array.from(STRATEGIES.keys()).join(", ")}`,
      inputDir,
    );
  }

  // 3. Discover service roots
  let serviceRoots;
  try {
    serviceRoots = await strategy.discoverServiceRoots(inputDir);
  } catch (err) {
    exitWithError(
      err.code === "ENOENT" || err.code === "EACCES" ? EXIT_CODES.IO_ERROR : EXIT_CODES.PARSE_ERROR,
      "Service discovery failed",
      err.message || String(err),
      "Check that the workspace directory is readable",
      inputDir,
    );
  }

  log("info", `Discovered ${serviceRoots.length} service root(s)`, { workspace: inputDir });

  if (serviceRoots.length === 0) {
    exitWithError(
      EXIT_CODES.PARSE_ERROR,
      "No service roots found",
      `No ${language} service roots were found in ${inputDir}`,
      `Ensure the workspace contains ${strategy.indicatorFiles.join(" or ")} at the service root`,
      inputDir,
    );
  }

  // 4. Analyze each service
  const services = [];
  let filesScanned = 0;

  for (const serviceRoot of serviceRoots) {
    log("info", `Analyzing service: ${path.basename(serviceRoot)}`, { serviceRoot });
    let service;
    try {
      service = await strategy.analyzeService(serviceRoot, inputDir);
    } catch (err) {
      exitWithError(
        err.code === "ENOENT" || err.code === "EACCES" ? EXIT_CODES.IO_ERROR : EXIT_CODES.PARSE_ERROR,
        `Failed to analyze service at ${serviceRoot}`,
        err.message || String(err),
        "Check the service directory for malformed source or manifest files",
        inputDir,
      );
    }
    if (service) {
      filesScanned += service._filesScanned || 0;
      delete service._filesScanned;
      service.language = language;
      services.push(service);
    }
  }

  // 5. Build cross-service edges (HTTP) and queue edges
  const httpEdges = buildServiceEdges(services);
  const { edges: queueEdges, queueChannels } = buildQueueEdges(services);
  const serviceEdges = [...httpEdges, ...queueEdges];

  const durationMs = Date.now() - startTime;
  logAlways("info", "Analysis complete", {
    language,
    serviceCount: services.length,
    edgeCount: serviceEdges.length,
    queueChannelCount: queueChannels.length,
    filesScanned,
    durationMs,
    workspace: inputDir,
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    inputDir,
    language,
    serviceCount: services.length,
    serviceEdges,
    queueChannels,
    services,
  };
}

/**
 * Write graph artifacts (JSON + summary) to an output directory.
 *
 * @param {Object} graph - ContextOutput from analyzeWorkspace()
 * @param {string} outputDir - Directory to write artifacts to
 */
export async function writeGraphArtifacts(graph, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, "service-graph.json"),
    `${JSON.stringify(graph, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(outputDir, "summary.md"),
    `${renderSummary(graph)}\n`,
    "utf8",
  );
}
