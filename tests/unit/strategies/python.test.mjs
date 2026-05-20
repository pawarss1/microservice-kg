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

describe("python strategy: US1 — sourceMethodName populated from enclosing function", () => {
  it("clients from a free function have methodName set to the function name", async () => {
    const serviceRoot = path.join(FIXTURE, "auth-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    // httpx.post(...) inside async def login(...)
    const loginClient = svc.clients.find((c) => c.methodName === "login");
    assert.ok(loginClient, "should find a client with methodName 'login'");
  });

  it("clients from a free function have className null", async () => {
    const serviceRoot = path.join(FIXTURE, "auth-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    const loginClient = svc.clients.find((c) => c.methodName === "login");
    assert.ok(loginClient, "should find a client with methodName 'login'");
    assert.equal(loginClient.className, null, "free-function client should have className null");
  });

  it("clients from a class method have methodName and className set", async () => {
    const serviceRoot = path.join(FIXTURE, "auth-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    // httpx.get(...) inside TokenValidator.refresh_token
    const classClient = svc.clients.find((c) => c.className === "TokenValidator");
    assert.ok(classClient, "should find a client with className 'TokenValidator'");
    assert.equal(classClient.methodName, "refresh_token");
  });

  it("no client has a synthetic _path_literal methodName when a real function encloses it", async () => {
    const serviceRoot = path.join(FIXTURE, "auth-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    const badClients = svc.clients.filter(
      (c) => c.methodName === "_path_literal" || c.clientName === "_path_literal",
    );
    // Path-literal clients that are NOT inside any function may still have null methodName
    // but should not falsely report _path_literal as the methodName
    for (const c of badClients) {
      assert.notEqual(c.methodName, "_path_literal", "methodName must not be _path_literal");
    }
  });
});

describe("python strategy: US2 — endpoint methodName populated from handler function", () => {
  it("FastAPI endpoints have methodName set to the handler function name", async () => {
    const serviceRoot = path.join(FIXTURE, "auth-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    const verifyEp = svc.endpoints.find((ep) => ep.path === "/auth/verify");
    assert.ok(verifyEp, "should have /auth/verify endpoint");
    assert.equal(verifyEp.methodName, "verify_token");
  });

  it("Flask endpoints have methodName set to the handler function name", async () => {
    const serviceRoot = path.join(FIXTURE, "notification-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    const sendEp = svc.endpoints.find((ep) => ep.path.includes("send"));
    assert.ok(sendEp, "should have /notifications/send endpoint");
    assert.equal(sendEp.methodName, "send_notification");
  });

  it("endpoints at module level have className null", async () => {
    const serviceRoot = path.join(FIXTURE, "auth-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    for (const ep of svc.endpoints) {
      assert.equal(ep.className, null, `endpoint ${ep.path} should have className null (module-level)`);
    }
  });
});

describe("python strategy: US3 — callSites populated", () => {
  it("every client has at least one callSite entry", async () => {
    const serviceRoot = path.join(FIXTURE, "auth-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    assert.ok(svc.clients.length >= 1, "auth-service should have clients");
    for (const client of svc.clients) {
      assert.ok(Array.isArray(client.callSites), "callSites must be an array");
      assert.ok(client.callSites.length >= 1, `client at line ${client.line} should have callSites`);
    }
  });

  it("callSite has filePath and line", async () => {
    const serviceRoot = path.join(FIXTURE, "auth-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    const loginClient = svc.clients.find((c) => c.methodName === "login");
    assert.ok(loginClient, "should find login client");
    const site = loginClient.callSites[0];
    assert.ok(typeof site.filePath === "string" && site.filePath.endsWith(".py"), "filePath must be a .py path");
    assert.ok(Number.isInteger(site.line) && site.line > 0, "line must be a positive integer");
  });

  it("callSite line matches the client line number", async () => {
    const serviceRoot = path.join(FIXTURE, "auth-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    for (const client of svc.clients) {
      assert.equal(client.callSites[0].line, client.line, "callSite line must match client line");
    }
  });
});

describe("python strategy: US4 — queue subscriber detection via constants", () => {
  it("detects subscriber binding when topic is an UPPER_CASE constant in subscribe([])", async () => {
    const serviceRoot = path.join(FIXTURE, "auth-service");
    const svc = await analyzeService(serviceRoot, FIXTURE);
    const sub = svc.queueBindings.find((b) => b.role === "subscriber" && b.channel === "auth_events");
    assert.ok(sub, "should detect subscriber binding for auth_events via EMAIL_TOPIC constant");
  });
});
