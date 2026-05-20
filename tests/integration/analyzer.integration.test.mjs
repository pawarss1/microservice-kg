/**
 * Integration tests: end-to-end analysis of fixture workspaces.
 * Covers: Java Spring regression (US3), Node.js (US1), Python (US2), auto-detection (US4).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/analyzer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "fixtures");

// ---------------------------------------------------------------------------
// US3: Java Spring Regression
// ---------------------------------------------------------------------------
describe("Java Spring workspace (US3 - regression)", () => {
  it("discovers 2 services", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "java-spring-workspace"), {
      language: "java-spring",
    });
    assert.equal(graph.serviceCount, 2);
    assert.equal(graph.services.length, 2);
  });

  it("sets language = java-spring on each service", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "java-spring-workspace"), {
      language: "java-spring",
    });
    assert.ok(graph.services.every((s) => s.language === "java-spring"));
  });

  it("each service has at least 1 endpoint", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "java-spring-workspace"), {
      language: "java-spring",
    });
    for (const service of graph.services) {
      assert.ok(service.endpoints.length >= 1, `${service.id} should have >= 1 endpoint`);
    }
  });

  it("order-service has at least 1 feign client", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "java-spring-workspace"), {
      language: "java-spring",
    });
    const orderService = graph.services.find((s) => s.id === "order-service");
    assert.ok(orderService, "order-service should exist");
    assert.ok(orderService.clients.length >= 1, "order-service should have >= 1 client");
  });

  it("creates a service edge from order-service to inventory-service", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "java-spring-workspace"), {
      language: "java-spring",
    });
    assert.ok(graph.serviceEdges.length >= 1, "should have at least 1 service edge");
    const edge = graph.serviceEdges.find(
      (e) => e.sourceServiceId === "order-service" && e.targetServiceId === "inventory-service",
    );
    assert.ok(edge, "should have edge from order-service to inventory-service");
  });

  it("output schema has required top-level fields", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "java-spring-workspace"), {
      language: "java-spring",
    });
    assert.equal(graph.version, 1);
    assert.ok(typeof graph.generatedAt === "string");
    assert.ok(typeof graph.inputDir === "string");
    assert.ok(Array.isArray(graph.services));
    assert.ok(Array.isArray(graph.serviceEdges));
  });
});

// ---------------------------------------------------------------------------
// US1: Node.js Workspace Context
// ---------------------------------------------------------------------------
describe("Node.js workspace (US1)", () => {
  it("discovers 2 services", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "nodejs-workspace"), {
      language: "nodejs",
    });
    assert.equal(graph.serviceCount, 2);
  });

  it("sets language = nodejs on each service", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "nodejs-workspace"), {
      language: "nodejs",
    });
    assert.ok(graph.services.every((s) => s.language === "nodejs"));
  });

  it("payment-service has at least 2 endpoints", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "nodejs-workspace"), {
      language: "nodejs",
    });
    const paymentService = graph.services.find((s) => s.id === "payment-service");
    assert.ok(paymentService, "payment-service should be discovered");
    assert.ok(paymentService.endpoints.length >= 2, "payment-service should have >= 2 endpoints");
  });

  it("payment-service has at least 1 HTTP client (axios)", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "nodejs-workspace"), {
      language: "nodejs",
    });
    const paymentService = graph.services.find((s) => s.id === "payment-service");
    assert.ok(paymentService, "payment-service should be discovered");
    assert.ok(paymentService.clients.length >= 1, "payment-service should have >= 1 HTTP client");
  });

  it("user-service has at least 2 endpoints", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "nodejs-workspace"), {
      language: "nodejs",
    });
    const userService = graph.services.find((s) => s.id === "user-service");
    assert.ok(userService, "user-service should be discovered");
    assert.ok(userService.endpoints.length >= 2, "user-service should have >= 2 endpoints");
  });

  it("service edge exists from payment-service to user-service", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "nodejs-workspace"), {
      language: "nodejs",
    });
    const edge = graph.serviceEdges.find(
      (e) => e.sourceServiceId === "payment-service" && e.targetServiceId === "user-service",
    );
    assert.ok(edge, "should have edge from payment-service to user-service");
  });
});

// ---------------------------------------------------------------------------
// US2: Python Workspace Context
// ---------------------------------------------------------------------------
describe("Python workspace (US2)", () => {
  it("discovers 2 services", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "python-workspace"), {
      language: "python",
    });
    assert.equal(graph.serviceCount, 2);
  });

  it("sets language = python on each service", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "python-workspace"), {
      language: "python",
    });
    assert.ok(graph.services.every((s) => s.language === "python"));
  });

  it("auth-service has FastAPI endpoints", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "python-workspace"), {
      language: "python",
    });
    const authService = graph.services.find((s) => s.id === "auth-service");
    assert.ok(authService, "auth-service should be discovered");
    assert.ok(authService.endpoints.length >= 2, "auth-service should have >= 2 endpoints");
  });

  it("notification-service has Flask endpoints", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "python-workspace"), {
      language: "python",
    });
    const notifService = graph.services.find((s) => s.id === "notification-service");
    assert.ok(notifService, "notification-service should be discovered");
    assert.ok(notifService.endpoints.length >= 2, "notification-service should have >= 2 endpoints");
  });

  it("auth-service has httpx client", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "python-workspace"), {
      language: "python",
    });
    const authService = graph.services.find((s) => s.id === "auth-service");
    assert.ok(authService, "auth-service should be discovered");
    assert.ok(authService.clients.length >= 1, "auth-service should have >= 1 HTTP client");
  });

  it("service edge exists from auth-service to notification-service", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "python-workspace"), {
      language: "python",
    });
    const edge = graph.serviceEdges.find(
      (e) => e.sourceServiceId === "auth-service" && e.targetServiceId === "notification-service",
    );
    assert.ok(edge, "should have edge from auth-service to notification-service");
  });
});

// ---------------------------------------------------------------------------
// US4: Language Auto-Detection
// ---------------------------------------------------------------------------
describe("Auto-detection (US4)", () => {
  it("auto-detects Java Spring workspace", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "java-spring-workspace"));
    assert.ok(graph.services.every((s) => s.language === "java-spring"));
  });

  it("auto-detects Node.js workspace", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "nodejs-workspace"));
    assert.ok(graph.services.every((s) => s.language === "nodejs"));
  });

  it("auto-detects Python workspace", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "python-workspace"));
    assert.ok(graph.services.every((s) => s.language === "python"));
  });

  it("auto-detected Java Spring output equals explicit language output", async () => {
    const fixtureDir = path.join(FIXTURES, "java-spring-workspace");
    const [auto, explicit] = await Promise.all([
      analyzeWorkspace(fixtureDir),
      analyzeWorkspace(fixtureDir, { language: "java-spring" }),
    ]);
    // Strip timestamps before comparing
    const strip = (g) => ({ ...g, generatedAt: "X" });
    assert.deepEqual(strip(auto), strip(explicit));
  });

  it("auto-detects TypeScript workspace", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "typescript-workspace"));
    assert.equal(graph.language, "typescript");
  });
});

// ---------------------------------------------------------------------------
// TypeScript Workspace (US1 - end-to-end analysis)
// ---------------------------------------------------------------------------
describe("TypeScript workspace (US1 - end-to-end)", () => {
  const TS_FIXTURE = path.join(FIXTURES, "typescript-workspace");

  it("discovers 2 services", async () => {
    const graph = await analyzeWorkspace(TS_FIXTURE, { language: "typescript" });
    assert.equal(graph.serviceCount, 2);
    assert.equal(graph.services.length, 2);
  });

  it("sets language = typescript on each service", async () => {
    const graph = await analyzeWorkspace(TS_FIXTURE, { language: "typescript" });
    assert.ok(graph.services.every((s) => s.language === "typescript"));
  });

  it("discovers api-gateway and notification-service", async () => {
    const graph = await analyzeWorkspace(TS_FIXTURE, { language: "typescript" });
    const ids = graph.services.map((s) => s.id).sort();
    assert.deepEqual(ids, ["api-gateway", "notification-service"]);
  });

  it("every service has all required fields", async () => {
    const graph = await analyzeWorkspace(TS_FIXTURE, { language: "typescript" });
    const REQUIRED = ["id", "name", "rootDir", "relativeRootDir", "aliases", "properties",
      "dependencies", "classes", "fields", "methods", "endpoints", "clients",
      "methodInteractions", "queueBindings"];
    for (const service of graph.services) {
      for (const field of REQUIRED) {
        assert.ok(field in service, `${service.id} should have field: ${field}`);
      }
    }
  });

  it("no service has null array fields", async () => {
    const graph = await analyzeWorkspace(TS_FIXTURE, { language: "typescript" });
    for (const service of graph.services) {
      for (const field of ["endpoints", "clients", "classes", "fields", "methods",
        "methodInteractions", "queueBindings", "aliases", "dependencies"]) {
        assert.ok(Array.isArray(service[field]), `${service.id}.${field} should be an array`);
      }
    }
  });

  it("output has required top-level schema fields", async () => {
    const graph = await analyzeWorkspace(TS_FIXTURE, { language: "typescript" });
    assert.equal(graph.version, 1);
    assert.ok(typeof graph.generatedAt === "string");
    assert.ok(typeof graph.inputDir === "string");
    assert.ok(Array.isArray(graph.services));
    assert.ok(Array.isArray(graph.serviceEdges));
    assert.ok(Array.isArray(graph.queueChannels));
    assert.equal(graph.language, "typescript");
  });

  it("api-gateway has at least 2 endpoints (NestJS routes)", async () => {
    const graph = await analyzeWorkspace(TS_FIXTURE, { language: "typescript" });
    const gateway = graph.services.find((s) => s.id === "api-gateway");
    assert.ok(gateway, "api-gateway should be discovered");
    assert.ok(gateway.endpoints.length >= 2, `expected >= 2 endpoints, got ${gateway.endpoints.length}`);
    const methods = gateway.endpoints.map((ep) => ep.httpMethod);
    assert.ok(methods.includes("GET"), "api-gateway should have a GET endpoint");
    assert.ok(methods.includes("POST"), "api-gateway should have a POST endpoint");
  });

  it("notification-service has at least 2 endpoints (Express routes)", async () => {
    const graph = await analyzeWorkspace(TS_FIXTURE, { language: "typescript" });
    const notif = graph.services.find((s) => s.id === "notification-service");
    assert.ok(notif, "notification-service should be discovered");
    assert.ok(notif.endpoints.length >= 2, `expected >= 2 endpoints, got ${notif.endpoints.length}`);
  });

  it("api-gateway has at least 1 HTTP client calling notification-service", async () => {
    const graph = await analyzeWorkspace(TS_FIXTURE, { language: "typescript" });
    const gateway = graph.services.find((s) => s.id === "api-gateway");
    assert.ok(gateway, "api-gateway should be discovered");
    assert.ok(gateway.clients.length >= 1, `expected >= 1 client, got ${gateway.clients.length}`);
  });

  it("service edge exists from api-gateway to notification-service", async () => {
    const graph = await analyzeWorkspace(TS_FIXTURE, { language: "typescript" });
    const edge = graph.serviceEdges.find(
      (e) => e.sourceServiceId === "api-gateway" && e.targetServiceId === "notification-service",
    );
    assert.ok(edge, "should have HTTP edge from api-gateway to notification-service");
  });

  it("queue channel user.created has correct publisher and subscriber", async () => {
    const graph = await analyzeWorkspace(TS_FIXTURE, { language: "typescript" });
    assert.ok(graph.queueChannels.length >= 1, "should have at least 1 queue channel");
    const channel = graph.queueChannels.find((c) => c.name === "user.created");
    assert.ok(channel, "should have user.created queue channel");
    assert.ok(channel.publishers.includes("api-gateway"), "api-gateway should be publisher");
    assert.ok(channel.subscribers.includes("notification-service"), "notification-service should be subscriber");
  });

  it("queue edge exists between api-gateway and notification-service", async () => {
    const graph = await analyzeWorkspace(TS_FIXTURE, { language: "typescript" });
    const queueEdge = graph.serviceEdges.find(
      (e) => e.sourceServiceId === "api-gateway" && e.targetServiceId === "notification-service"
        && e.protocol === "queue",
    );
    assert.ok(queueEdge, "should have queue edge from api-gateway to notification-service");
  });
});
