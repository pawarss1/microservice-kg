#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { analyzeWorkspace, writeGraphArtifacts } from "./analyzer.mjs";
import { SUPPORTED_LANGUAGES } from "./detector.mjs";
import { exitWithError, EXIT_CODES } from "./logger.mjs";

function printUsage() {
  console.log(`Usage:
  microservice-kg analyze <input-directory> [options]

Options:
  --language <lang>   Force language detection. Values: ${SUPPORTED_LANGUAGES.join(", ")}
  --output <dir>      Write artifacts to <dir> instead of <input>/.microservice-kg
  --stdout            Print context JSON to stdout instead of writing to a file
  --verbose           Show per-file progress and detection details
  --json-logs         Emit structured NDJSON logs to stderr (CI-friendly)
  -h, --help          Show this help message

Examples:
  microservice-kg analyze /path/to/workspace
  microservice-kg analyze /path/to/workspace --language nodejs
  microservice-kg analyze /path/to/workspace --stdout > context.json
  microservice-kg analyze /path/to/workspace --output /tmp/kg --verbose
  microservice-kg analyze /path/to/workspace --json-logs --output /tmp/kg
`);
}

function parseArgs(argv) {
  const [, , command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    return { help: true };
  }

  const options = {
    command,
    inputDir: null,
    outputDir: null,
    stdout: false,
    language: null,
    verbose: false,
    jsonLogs: false,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--output" || token === "-o") {
      options.outputDir = rest[index + 1];
      index += 1;
    } else if (token === "--language" || token === "-l") {
      options.language = rest[index + 1];
      index += 1;
    } else if (token === "--stdout") {
      options.stdout = true;
    } else if (token === "--verbose" || token === "-v") {
      options.verbose = true;
    } else if (token === "--json-logs") {
      options.jsonLogs = true;
    } else if (!token.startsWith("-") && !options.inputDir) {
      options.inputDir = token;
    }
  }

  return options;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.command) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  if (args.command !== "analyze" || !args.inputDir) {
    printUsage();
    process.exit(EXIT_CODES.PARSE_ERROR);
  }

  const inputDir = path.resolve(args.inputDir);

  const graph = await analyzeWorkspace(inputDir, {
    language: args.language || undefined,
    verbose: args.verbose,
    jsonLogs: args.jsonLogs,
  });

  if (args.stdout) {
    process.stdout.write(JSON.stringify(graph, null, 2) + "\n");
    return;
  }

  const outputDir = args.outputDir
    ? path.resolve(args.outputDir)
    : path.join(inputDir, ".microservice-kg");

  await writeGraphArtifacts(graph, outputDir);

  // Human-readable completion summary to stdout (unchanged from original)
  console.log(`Analyzed workspace: ${inputDir}`);
  console.log(`Language detected: ${graph.language}`);
  console.log(`Discovered services: ${graph.serviceCount}`);
  console.log(`Discovered service edges: ${graph.serviceEdges.length}`);
  console.log(`Wrote graph to: ${path.join(outputDir, "service-graph.json")}`);
  console.log(`Wrote summary to: ${path.join(outputDir, "summary.md")}`);
}

main().catch((error) => {
  process.stderr.write(`[ERROR] ${error?.stack || error?.message || String(error)}\n`);
  process.exit(EXIT_CODES.PARSE_ERROR);
});
