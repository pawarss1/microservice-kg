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
});
