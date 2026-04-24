/**
 * Unit tests for the Node.js strategy.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverServiceRoots,
  analyzeService,
} from "../../../src/strategies/nodejs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, "../../integration/fixtures/nodejs-workspace");

describe("nodejs strategy: discoverServiceRoots", () => {
  it("finds both service sub-directories", async () => {
    const roots = await discoverServiceRoots(FIXTURE);
    assert.ok(Array.isArray(roots));
    assert.equal(roots.length, 2);
    const names = roots.map((r) => path.basename(r)).sort();
    assert.deepEqual(names, ["payment-service", "user-service"]);
  });

  it("returns sorted list", async () => {
    const roots = await discoverServiceRoots(FIXTURE);
    const sorted = [...roots].sort();
    assert.deepEqual(roots, sorted);
  });
});

describe("nodejs strategy: analyzeService - payment-service", () => {
  let service;

  // Run once and reuse
  before: {
    // node:test doesn't support before() at top level; use lazy init
  }

  it("returns correct service id from package.json name", async () => {
    const serviceRoot = path.join(FIXTURE, "payment-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    assert.equal(svc.id, "payment-service");
  });

  it("extracts GET and POST endpoints", async () => {
    const serviceRoot = path.join(FIXTURE, "payment-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    assert.ok(svc.endpoints.length >= 2, `expected >= 2 endpoints, got ${svc.endpoints.length}`);
    const methods = svc.endpoints.map((ep) => ep.httpMethod);
    assert.ok(methods.includes("GET"), "should have a GET endpoint");
    assert.ok(methods.includes("POST"), "should have a POST endpoint");
  });

  it("detects axios HTTP client", async () => {
    const serviceRoot = path.join(FIXTURE, "payment-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    assert.ok(svc.clients.length >= 1, `expected >= 1 client, got ${svc.clients.length}`);
    const hasAxios = svc.clients.some((c) => c.clientName === "axios");
    assert.ok(hasAxios, "should detect axios as HTTP client");
  });

  it("loads PORT from .env", async () => {
    const serviceRoot = path.join(FIXTURE, "payment-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    assert.equal(svc.properties["PORT"], "3001");
  });

  it("populates relativeRootDir correctly", async () => {
    const serviceRoot = path.join(FIXTURE, "payment-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    assert.equal(svc.relativeRootDir, "payment-service");
  });

  it("service result has all required fields", async () => {
    const serviceRoot = path.join(FIXTURE, "payment-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    for (const field of ["id", "name", "rootDir", "relativeRootDir", "aliases", "properties", "classes", "fields", "methods", "endpoints", "clients", "methodInteractions"]) {
      assert.ok(field in svc, `service should have field: ${field}`);
    }
  });
});

describe("nodejs strategy: analyzeService - user-service", () => {
  it("returns correct service id", async () => {
    const serviceRoot = path.join(FIXTURE, "user-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    assert.equal(svc.id, "user-service");
  });

  it("extracts GET and POST endpoints", async () => {
    const serviceRoot = path.join(FIXTURE, "user-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    assert.ok(svc.endpoints.length >= 2, `expected >= 2 endpoints, got ${svc.endpoints.length}`);
  });

  it("has no HTTP clients (does not call other services)", async () => {
    const serviceRoot = path.join(FIXTURE, "user-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    assert.equal(svc.clients.length, 0, "user-service should have no outgoing HTTP clients");
  });
});
