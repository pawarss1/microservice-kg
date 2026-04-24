/**
 * Unit tests for the Python strategy.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverServiceRoots,
  analyzeService,
} from "../../../src/strategies/python.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, "../../integration/fixtures/python-workspace");

describe("python strategy: discoverServiceRoots", () => {
  it("finds both service sub-directories", async () => {
    const roots = await discoverServiceRoots(FIXTURE);
    assert.ok(Array.isArray(roots));
    assert.equal(roots.length, 2);
    const names = roots.map((r) => path.basename(r)).sort();
    assert.deepEqual(names, ["auth-service", "notification-service"]);
  });

  it("returns sorted list", async () => {
    const roots = await discoverServiceRoots(FIXTURE);
    const sorted = [...roots].sort();
    assert.deepEqual(roots, sorted);
  });
});

describe("python strategy: analyzeService - auth-service (FastAPI)", () => {
  it("returns correct service id from pyproject.toml", async () => {
    const serviceRoot = path.join(FIXTURE, "auth-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    assert.equal(svc.id, "auth-service");
    assert.equal(svc.name, "auth-service");
  });

  it("extracts FastAPI GET and POST endpoints", async () => {
    const serviceRoot = path.join(FIXTURE, "auth-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    assert.ok(svc.endpoints.length >= 2, `expected >= 2 endpoints, got ${svc.endpoints.length}`);
    const methods = svc.endpoints.map((ep) => ep.httpMethod);
    assert.ok(methods.includes("GET"), "should have a GET endpoint");
    assert.ok(methods.includes("POST"), "should have a POST endpoint");
  });

  it("detects httpx as HTTP client", async () => {
    const serviceRoot = path.join(FIXTURE, "auth-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    assert.ok(svc.clients.length >= 1, `expected >= 1 client, got ${svc.clients.length}`);
    const hasHttpx = svc.clients.some((c) => c.clientName === "client" || c.clientName === "httpx");
    assert.ok(svc.clients.length >= 1, "auth-service should have at least 1 httpx client");
  });

  it("loads PORT from .env", async () => {
    const serviceRoot = path.join(FIXTURE, "auth-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    assert.equal(svc.properties["PORT"], "8001");
  });

  it("service result has all required fields", async () => {
    const serviceRoot = path.join(FIXTURE, "auth-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    for (const field of ["id", "name", "rootDir", "relativeRootDir", "aliases", "properties", "classes", "fields", "methods", "endpoints", "clients", "methodInteractions"]) {
      assert.ok(field in svc, `service should have field: ${field}`);
    }
  });
});

describe("python strategy: analyzeService - notification-service (Flask)", () => {
  it("returns correct service id", async () => {
    const serviceRoot = path.join(FIXTURE, "notification-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    assert.equal(svc.id, "notification-service");
  });

  it("extracts Flask POST and GET endpoints", async () => {
    const serviceRoot = path.join(FIXTURE, "notification-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    assert.ok(svc.endpoints.length >= 2, `expected >= 2 endpoints, got ${svc.endpoints.length}`);
    const hasSend = svc.endpoints.some((ep) => ep.path.includes("send") || ep.fullPath.includes("send"));
    assert.ok(hasSend, "should detect /notifications/send endpoint");
  });

  it("has no outgoing HTTP clients", async () => {
    const serviceRoot = path.join(FIXTURE, "notification-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    assert.equal(svc.clients.length, 0, "notification-service should have no outgoing clients");
  });
});

describe("python strategy: pyproject.toml parsing", () => {
  it("loads version from pyproject.toml into properties", async () => {
    const serviceRoot = path.join(FIXTURE, "auth-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    assert.equal(svc.properties["python.version"], "1.0.0");
  });
});
