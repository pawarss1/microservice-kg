/**
 * Contract test: validates that the ContextOutput from each language
 * fixture conforms to the unified output schema defined in contracts/output-schema.json.
 *
 * Uses structural validation (not JSON Schema library) to stay dependency-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/analyzer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "../integration/fixtures");

function assertString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
}
function assertNumber(value, label) {
  assert.equal(typeof value, "number", `${label} must be a number`);
}
function assertArray(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
}

function validateContextOutput(graph, label) {
  assertNumber(graph.version, `${label}.version`);
  assert.equal(graph.version, 1, `${label}.version must be 1`);
  assertString(graph.generatedAt, `${label}.generatedAt`);
  assertString(graph.inputDir, `${label}.inputDir`);
  assertNumber(graph.serviceCount, `${label}.serviceCount`);
  assertArray(graph.services, `${label}.services`);
  assertArray(graph.serviceEdges, `${label}.serviceEdges`);
  assert.equal(graph.services.length, graph.serviceCount, `${label}.serviceCount must match services.length`);

  for (const service of graph.services) {
    assertString(service.id, "service.id");
    assertString(service.name, "service.name");
    assertString(service.language, "service.language");
    assert.ok(
      ["java-spring", "nodejs", "python", "typescript"].includes(service.language),
      `service.language "${service.language}" must be a supported language`,
    );
    assertString(service.rootDir, "service.rootDir");
    assertString(service.relativeRootDir, "service.relativeRootDir");
    assertArray(service.aliases, "service.aliases");
    assert.ok(service.properties !== null && typeof service.properties === "object", "service.properties must be object");
    assertArray(service.classes, "service.classes");
    assertArray(service.fields, "service.fields");
    assertArray(service.methods, "service.methods");
    assertArray(service.endpoints, "service.endpoints");
    assertArray(service.clients, "service.clients");
    assertArray(service.methodInteractions, "service.methodInteractions");

    for (const endpoint of service.endpoints) {
      assertString(endpoint.httpMethod, "endpoint.httpMethod");
      assert.ok(
        ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(endpoint.httpMethod),
        `endpoint.httpMethod "${endpoint.httpMethod}" must be a valid HTTP verb`,
      );
      assertString(endpoint.filePath, "endpoint.filePath");
      assertNumber(endpoint.line, "endpoint.line");
    }
  }

  for (const edge of graph.serviceEdges) {
    assertString(edge.id, "edge.id");
    assertString(edge.sourceServiceId, "edge.sourceServiceId");
    assertString(edge.targetServiceId, "edge.targetServiceId");
    assert.ok(["http", "queue"].includes(edge.protocol), `edge.protocol "${edge.protocol}" must be http or queue`);
    assertArray(edge.reasons, "edge.reasons");
    assertArray(edge.calls, "edge.calls");
  }
}

describe("Contract: ContextOutput schema", () => {
  it("Java Spring workspace produces valid schema", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "java-spring-workspace"), { language: "java-spring" });
    validateContextOutput(graph, "java-spring");
    assert.ok(graph.services.every((s) => s.language === "java-spring"), "all services should have language = java-spring");
    assert.ok(graph.serviceCount >= 2, "should discover at least 2 services");
  });

  it("Node.js workspace produces valid schema", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "nodejs-workspace"), { language: "nodejs" });
    validateContextOutput(graph, "nodejs");
    assert.ok(graph.services.every((s) => s.language === "nodejs"), "all services should have language = nodejs");
    assert.ok(graph.serviceCount >= 2, "should discover at least 2 services");
  });

  it("Python workspace produces valid schema", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "python-workspace"), { language: "python" });
    validateContextOutput(graph, "python");
    assert.ok(graph.services.every((s) => s.language === "python"), "all services should have language = python");
    assert.ok(graph.serviceCount >= 2, "should discover at least 2 services");
  });
});

describe("Contract: ContextOutput schema — TypeScript workspace (T025)", () => {
  it("TypeScript workspace produces valid schema", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "typescript-workspace"), { language: "typescript" });
    validateContextOutput(graph, "typescript");
    assert.ok(graph.services.every((s) => s.language === "typescript"), "all services should have language = typescript");
    assert.equal(graph.serviceCount, 2, "should discover exactly 2 services");
  });

  it("TypeScript workspace auto-detects as typescript", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "typescript-workspace"));
    assert.equal(graph.language, "typescript");
    validateContextOutput(graph, "typescript-auto");
  });
});

describe("Contract: Python call field quality (US1, US2, US3)", () => {
  it("all Python calls have non-empty callSites", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "python-workspace"), { language: "python" });
    const httpEdges = graph.serviceEdges.filter((e) => e.protocol === "http");
    for (const edge of httpEdges) {
      for (const call of edge.calls) {
        assertArray(call.callSites, `call.callSites (${edge.id})`);
        assert.ok(call.callSites.length >= 1, `calls[].callSites must be non-empty for edge ${edge.id}`);
        assertString(call.callSites[0].filePath, "callSites[0].filePath");
        assertNumber(call.callSites[0].line, "callSites[0].line");
        assert.ok(call.callSites[0].line > 0, "callSites[0].line must be positive");
      }
    }
  });

  it("all Python calls have a valid Python identifier as sourceMethodName", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "python-workspace"), { language: "python" });
    const httpEdges = graph.serviceEdges.filter((e) => e.protocol === "http");
    const IDENTIFIER_RE = /^[a-z_]\w*$/i;
    for (const edge of httpEdges) {
      for (const call of edge.calls) {
        if (call.sourceMethodName !== null) {
          assert.ok(
            IDENTIFIER_RE.test(call.sourceMethodName),
            `sourceMethodName "${call.sourceMethodName}" must be a valid Python identifier (edge: ${edge.id})`,
          );
        }
      }
    }
  });

  it("all Python provider objects with targetFilePath have a non-null targetMethodName", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "python-workspace"), { language: "python" });
    for (const edge of graph.serviceEdges.filter((e) => e.protocol === "http")) {
      for (const call of edge.calls) {
        if (call.provider && call.provider.targetFilePath) {
          assert.ok(
            call.provider.targetMethodName !== null,
            `provider.targetMethodName must be non-null when targetFilePath is set (edge: ${edge.id})`,
          );
        }
      }
    }
  });
});
