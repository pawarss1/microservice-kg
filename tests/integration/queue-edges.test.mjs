/**
 * Integration tests: queue-based service edge discovery.
 *
 * Analyzes the nodejs-multi-service fixture (service-a publisher,
 * service-b and service-c subscribers) and validates:
 *  - Queue edges appear in serviceEdges with protocol: "queue"
 *  - Fan-out: both subscribers receive edges from the publisher
 *  - queueChannels top-level field is populated correctly
 *  - Existing HTTP edge behaviour is unaffected
 *  - blast-radius (getServiceImpact) traverses queue edges
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/analyzer.mjs";
import { GraphStore, getServiceImpact, getServiceContext } from "../../src/graph-query.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, "fixtures/nodejs-multi-service");

describe("Queue edges: nodejs-multi-service fixture", () => {
  let graph;

  before(async () => {
    graph = await analyzeWorkspace(FIXTURE, { language: "nodejs" });
  });

  // -------------------------------------------------------------------------
  // Basic graph shape
  // -------------------------------------------------------------------------

  it("discovers all three services", () => {
    assert.equal(graph.serviceCount, 3);
    const ids = graph.services.map((s) => s.id).sort();
    assert.deepEqual(ids, ["service-a", "service-b", "service-c"]);
  });

  it("each service has queueBindings populated", () => {
    const a = graph.services.find((s) => s.id === "service-a");
    const b = graph.services.find((s) => s.id === "service-b");
    const c = graph.services.find((s) => s.id === "service-c");

    assert.equal(a.queueBindings.length, 1);
    assert.deepEqual(a.queueBindings[0], { channel: "order-events", role: "publisher" });

    assert.equal(b.queueBindings.length, 1);
    assert.deepEqual(b.queueBindings[0], { channel: "order-events", role: "subscriber" });

    assert.equal(c.queueBindings.length, 1);
    assert.deepEqual(c.queueBindings[0], { channel: "order-events", role: "subscriber" });
  });

  // -------------------------------------------------------------------------
  // serviceEdges queue edges
  // -------------------------------------------------------------------------

  it("serviceEdges contains exactly two queue edges", () => {
    const queueEdges = graph.serviceEdges.filter((e) => e.protocol === "queue");
    assert.equal(queueEdges.length, 2);
  });

  it("queue edge service-a → service-b is present", () => {
    const edge = graph.serviceEdges.find(
      (e) => e.protocol === "queue" && e.sourceServiceId === "service-a" && e.targetServiceId === "service-b",
    );
    assert.ok(edge, "expected service-a → service-b queue edge");
    assert.equal(edge.channelName, "order-events");
    assert.equal(edge.reasons[0].type, "queue-pubsub");
  });

  it("queue edge service-a → service-c is present", () => {
    const edge = graph.serviceEdges.find(
      (e) => e.protocol === "queue" && e.sourceServiceId === "service-a" && e.targetServiceId === "service-c",
    );
    assert.ok(edge, "expected service-a → service-c queue edge");
    assert.equal(edge.channelName, "order-events");
  });

  // -------------------------------------------------------------------------
  // queueChannels top-level field
  // -------------------------------------------------------------------------

  it("graph has queueChannels array", () => {
    assert.ok(Array.isArray(graph.queueChannels));
  });

  it("queueChannels has one entry for order-events", () => {
    assert.equal(graph.queueChannels.length, 1);
    assert.equal(graph.queueChannels[0].name, "order-events");
  });

  it("queueChannels[0] has correct publishers and subscribers (sorted)", () => {
    const ch = graph.queueChannels[0];
    assert.deepEqual(ch.publishers, ["service-a"]);
    assert.deepEqual(ch.subscribers, ["service-b", "service-c"]);
  });

  // -------------------------------------------------------------------------
  // Existing HTTP edges unaffected (fixture has no HTTP clients — zero HTTP edges)
  // -------------------------------------------------------------------------

  it("no HTTP edges exist in this fixture (no HTTP clients declared)", () => {
    const httpEdges = graph.serviceEdges.filter((e) => e.protocol === "http");
    assert.equal(httpEdges.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Graph query: blast-radius traversal includes queue edges
// ---------------------------------------------------------------------------

describe("Queue edges: getServiceImpact traverses queue edges", () => {
  let store;

  before(async () => {
    const graph = await analyzeWorkspace(FIXTURE, { language: "nodejs" });
    store = new GraphStore();
    store.graph = graph;
    store.graphPath = FIXTURE;
  });

  it("service-a downstream impact includes service-b and service-c", async () => {
    const result = await getServiceImpact(store, { serviceId: "service-a", direction: "downstream" });
    const impactedIds = result.impactedServices.map((s) => s.serviceId).sort();
    assert.ok(impactedIds.includes("service-b"), "service-b must appear in impact");
    assert.ok(impactedIds.includes("service-c"), "service-c must appear in impact");
  });

  it("service-b upstream impact includes service-a", async () => {
    const result = await getServiceImpact(store, { serviceId: "service-b", direction: "upstream" });
    const impactedIds = result.impactedServices.map((s) => s.serviceId);
    assert.ok(impactedIds.includes("service-a"), "service-a must appear as upstream of service-b");
  });

  it("service-c upstream impact includes service-a", async () => {
    const result = await getServiceImpact(store, { serviceId: "service-c", direction: "upstream" });
    const impactedIds = result.impactedServices.map((s) => s.serviceId);
    assert.ok(impactedIds.includes("service-a"), "service-a must appear as upstream of service-c");
  });
});

// ---------------------------------------------------------------------------
// Graph query: getServiceContext surfaces queue edges
// ---------------------------------------------------------------------------

describe("Queue edges: getServiceContext includes queue relationships", () => {
  let store;

  before(async () => {
    const graph = await analyzeWorkspace(FIXTURE, { language: "nodejs" });
    store = new GraphStore();
    store.graph = graph;
    store.graphPath = FIXTURE;
  });

  it("service-a has two outgoing edges in context", async () => {
    const ctx = await getServiceContext(store, { serviceId: "service-a" });
    assert.equal(ctx.outgoing.length, 2);
  });

  it("service-b has one incoming edge in context", async () => {
    const ctx = await getServiceContext(store, { serviceId: "service-b" });
    assert.equal(ctx.incoming.length, 1);
    assert.equal(ctx.incoming[0].sourceServiceId, "service-a");
  });
});
