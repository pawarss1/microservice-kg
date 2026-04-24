/**
 * Contract test: validates queue-related fields in ContextOutput.
 *
 * Verifies that:
 *  - graph.queueChannels is always present (array, defaults to [])
 *  - Each queueChannel entry has the correct shape
 *  - Queue edges in serviceEdges have the correct shape
 *  - Queue edges carry protocol: "queue", channelName, and reasons of type "queue-pubsub"
 *  - Existing HTTP edge schema is unaffected
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/analyzer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "../integration/fixtures");
const QUEUE_FIXTURE = path.join(FIXTURES, "nodejs-multi-service");

function assertString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.length > 0, `${label} must not be empty`);
}

function assertArray(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
}

function assertSortedStringArray(arr, label) {
  assertArray(arr, label);
  const sorted = [...arr].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(arr, sorted, `${label} must be sorted alphabetically`);
}

// ---------------------------------------------------------------------------
// queueChannels field presence on all fixture types
// ---------------------------------------------------------------------------

describe("Contract: queueChannels field present on all workspaces", () => {
  it("nodejs-workspace has queueChannels: [] (no config files)", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "nodejs-workspace"), { language: "nodejs" });
    assertArray(graph.queueChannels, "graph.queueChannels");
    assert.equal(graph.queueChannels.length, 0);
  });

  it("nodejs-multi-service has queueChannels with one entry", async () => {
    const graph = await analyzeWorkspace(QUEUE_FIXTURE, { language: "nodejs" });
    assertArray(graph.queueChannels, "graph.queueChannels");
    assert.equal(graph.queueChannels.length, 1);
  });
});

// ---------------------------------------------------------------------------
// queueChannels entry shape
// ---------------------------------------------------------------------------

describe("Contract: queueChannel entry shape", () => {
  let graph;
  before(async () => {
    graph = await analyzeWorkspace(QUEUE_FIXTURE, { language: "nodejs" });
  });

  it("each queueChannel has a non-empty name string", () => {
    for (const ch of graph.queueChannels) {
      assertString(ch.name, "queueChannel.name");
    }
  });

  it("each queueChannel has sorted publishers array", () => {
    for (const ch of graph.queueChannels) {
      assertSortedStringArray(ch.publishers, `queueChannel[${ch.name}].publishers`);
    }
  });

  it("each queueChannel has sorted subscribers array", () => {
    for (const ch of graph.queueChannels) {
      assertSortedStringArray(ch.subscribers, `queueChannel[${ch.name}].subscribers`);
    }
  });

  it("queueChannels are sorted by name", () => {
    const names = graph.queueChannels.map((c) => c.name);
    assertSortedStringArray(names, "queueChannels[].name list");
  });
});

// ---------------------------------------------------------------------------
// Queue edge shape in serviceEdges
// ---------------------------------------------------------------------------

describe("Contract: queue edges in serviceEdges", () => {
  let graph;
  before(async () => {
    graph = await analyzeWorkspace(QUEUE_FIXTURE, { language: "nodejs" });
  });

  it("queue edges have protocol: 'queue'", () => {
    const queueEdges = graph.serviceEdges.filter((e) => e.protocol === "queue");
    assert.ok(queueEdges.length > 0, "at least one queue edge must exist");
    for (const edge of queueEdges) {
      assert.equal(edge.protocol, "queue");
    }
  });

  it("queue edges have a non-empty channelName string", () => {
    for (const edge of graph.serviceEdges.filter((e) => e.protocol === "queue")) {
      assertString(edge.channelName, `edge[${edge.id}].channelName`);
    }
  });

  it("queue edges have non-empty id, sourceServiceId, targetServiceId", () => {
    for (const edge of graph.serviceEdges.filter((e) => e.protocol === "queue")) {
      assertString(edge.id, `edge.id`);
      assertString(edge.sourceServiceId, `edge.sourceServiceId`);
      assertString(edge.targetServiceId, `edge.targetServiceId`);
    }
  });

  it("queue edges have reasons array with type queue-pubsub", () => {
    for (const edge of graph.serviceEdges.filter((e) => e.protocol === "queue")) {
      assertArray(edge.reasons, `edge[${edge.id}].reasons`);
      assert.ok(edge.reasons.length >= 1, "at least one reason required");
      for (const reason of edge.reasons) {
        assert.equal(reason.type, "queue-pubsub", "queue edge reasons must have type queue-pubsub");
        assertString(reason.channelName, "reason.channelName");
        assertString(reason.publisherServiceId, "reason.publisherServiceId");
        assertString(reason.subscriberServiceId, "reason.subscriberServiceId");
      }
    }
  });

  it("queue edges have an empty calls array", () => {
    for (const edge of graph.serviceEdges.filter((e) => e.protocol === "queue")) {
      assertArray(edge.calls, `edge[${edge.id}].calls`);
      assert.equal(edge.calls.length, 0, "queue edges must have no call-site evidence");
    }
  });
});

// ---------------------------------------------------------------------------
// Existing HTTP edges: schema must be unchanged
// ---------------------------------------------------------------------------

describe("Contract: HTTP edge schema unaffected by queue changes", () => {
  it("nodejs-workspace HTTP edges still have protocol: http, reasons, calls", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "nodejs-workspace"), { language: "nodejs" });
    const httpEdges = graph.serviceEdges.filter((e) => e.protocol === "http");
    for (const edge of httpEdges) {
      assert.equal(edge.protocol, "http");
      assertArray(edge.reasons, `edge[${edge.id}].reasons`);
      assertArray(edge.calls, `edge[${edge.id}].calls`);
    }
  });
});

// ---------------------------------------------------------------------------
// queueBindings on service objects
// ---------------------------------------------------------------------------

describe("Contract: queueBindings field on service objects", () => {
  it("services in queue fixture have queueBindings array", async () => {
    const graph = await analyzeWorkspace(QUEUE_FIXTURE, { language: "nodejs" });
    for (const service of graph.services) {
      assertArray(service.queueBindings, `service[${service.id}].queueBindings`);
      for (const binding of service.queueBindings) {
        assertString(binding.channel, "binding.channel");
        assert.ok(
          binding.role === "publisher" || binding.role === "subscriber",
          `binding.role must be publisher or subscriber, got "${binding.role}"`,
        );
      }
    }
  });

  it("services in standard nodejs workspace have queueBindings: []", async () => {
    const graph = await analyzeWorkspace(path.join(FIXTURES, "nodejs-workspace"), { language: "nodejs" });
    for (const service of graph.services) {
      assertArray(service.queueBindings, `service[${service.id}].queueBindings`);
      assert.equal(service.queueBindings.length, 0);
    }
  });
});
