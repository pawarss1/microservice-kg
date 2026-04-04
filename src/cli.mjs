#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { analyzeWorkspace, writeGraphArtifacts } from "./analyzer.mjs";

function printUsage() {
  console.log(`Usage:
  microservice-kg analyze <input-directory> [--output <output-directory>]

Examples:
  microservice-kg analyze /Users/me/workspace/services
  microservice-kg analyze /Users/me/workspace/services --output /tmp/service-kg
`);
}

function parseArgs(argv) {
  const [, , command, maybeInput, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    return { help: true };
  }

  const options = {
    command,
    inputDir: maybeInput,
    outputDir: null,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--output" || token === "-o") {
      options.outputDir = rest[index + 1];
      index += 1;
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
    process.exit(1);
  }

  const inputDir = path.resolve(args.inputDir);
  const outputDir = args.outputDir
    ? path.resolve(args.outputDir)
    : path.join(inputDir, ".microservice-kg");

  const graph = await analyzeWorkspace(inputDir);
  await writeGraphArtifacts(graph, outputDir);

  console.log(`Analyzed workspace: ${inputDir}`);
  console.log(`Discovered services: ${graph.serviceCount}`);
  console.log(`Discovered service edges: ${graph.serviceEdges.length}`);
  console.log(`Wrote graph to: ${path.join(outputDir, "service-graph.json")}`);
  console.log(`Wrote summary to: ${path.join(outputDir, "summary.md")}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
