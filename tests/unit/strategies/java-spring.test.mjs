/**
 * Unit tests for the Java Spring strategy.
 * Tests parsing functions with inline fixture strings to avoid I/O.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  discoverServiceRoots,
  analyzeService,
} from "../../../src/strategies/java-spring.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, "../../integration/fixtures/java-spring-workspace");

describe("java-spring strategy: discoverServiceRoots", () => {
  it("finds both service roots in the fixture workspace", async () => {
    const roots = await discoverServiceRoots(FIXTURE);
    assert.ok(Array.isArray(roots));
    assert.equal(roots.length, 2);
    const names = roots.map((r) => path.basename(r)).sort();
    assert.deepEqual(names, ["inventory-service", "order-service"]);
  });

  it("returns a sorted list", async () => {
    const roots = await discoverServiceRoots(FIXTURE);
    const sorted = [...roots].sort();
    assert.deepEqual(roots, sorted);
  });

  it("returns empty array for empty directory", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kg-test-"));
    try {
      const roots = await discoverServiceRoots(tmp);
      assert.deepEqual(roots, []);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("java-spring strategy: analyzeService", () => {
  it("returns service with correct id and name", async () => {
    const orderRoot = path.join(FIXTURE, "order-service");
    const service = await analyzeService(orderRoot, FIXTURE);
    assert.equal(service.id, "order-service");
    assert.equal(service.name, "order-service"); // from spring.application.name
  });

  it("extracts endpoints from @GetMapping and @PostMapping", async () => {
    const orderRoot = path.join(FIXTURE, "order-service");
    const service = await analyzeService(orderRoot, FIXTURE);
    assert.ok(service.endpoints.length >= 2, "should have at least 2 endpoints");
    const methods = service.endpoints.map((ep) => ep.httpMethod);
    assert.ok(methods.includes("GET"), "should have a GET endpoint");
    assert.ok(methods.includes("POST"), "should have a POST endpoint");
  });

  it("extracts FeignClient as a client", async () => {
    const orderRoot = path.join(FIXTURE, "order-service");
    const service = await analyzeService(orderRoot, FIXTURE);
    assert.ok(service.clients.length >= 1, "should have at least 1 client");
    const client = service.clients[0];
    assert.ok(client.feignName || client.clientName, "client should have a name");
  });

  it("loads spring.application.name from properties", async () => {
    const inventoryRoot = path.join(FIXTURE, "inventory-service");
    const service = await analyzeService(inventoryRoot, FIXTURE);
    assert.equal(service.name, "inventory-service");
  });

  it("populates relativeRootDir correctly", async () => {
    const orderRoot = path.join(FIXTURE, "order-service");
    const service = await analyzeService(orderRoot, FIXTURE);
    assert.equal(service.relativeRootDir, "order-service");
  });

  it("service result has all required fields", async () => {
    const orderRoot = path.join(FIXTURE, "order-service");
    const service = await analyzeService(orderRoot, FIXTURE);
    for (const field of ["id", "name", "rootDir", "relativeRootDir", "aliases", "properties", "classes", "fields", "methods", "endpoints", "clients", "methodInteractions"]) {
      assert.ok(field in service, `service should have field: ${field}`);
    }
    assert.ok(Array.isArray(service.aliases));
    assert.ok(Array.isArray(service.endpoints));
    assert.ok(Array.isArray(service.clients));
  });
});
