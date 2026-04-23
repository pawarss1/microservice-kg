/**
 * Unit tests for queue-related helpers in src/strategies/base.mjs:
 *   - readQueueConfig(serviceRoot)
 *   - buildQueueEdges(services)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readQueueConfig, buildQueueEdges } from "../../src/strategies/base.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "mkg-test-"));
}

async function writeConfig(dir, content) {
  await fs.writeFile(path.join(dir, "microservice-kg.config.json"), JSON.stringify(content), "utf8");
}

// ---------------------------------------------------------------------------
// readQueueConfig
// ---------------------------------------------------------------------------

describe("readQueueConfig: missing file", () => {
  it("returns [] when microservice-kg.config.json does not exist", async () => {
    const dir = await makeTempDir();
    try {
      const result = await readQueueConfig(dir);
      assert.deepEqual(result, []);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});

describe("readQueueConfig: valid config", () => {
  let dir;
  before(async () => {
    dir = await makeTempDir();
    await writeConfig(dir, {
      queues: [
        { channel: "order-events", role: "publisher" },
        { channel: "payment-results", role: "subscriber" },
      ],
    });
  });
  after(async () => { await fs.rm(dir, { recursive: true }); });

  it("returns all valid bindings", async () => {
    const result = await readQueueConfig(dir);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { channel: "order-events", role: "publisher" });
    assert.deepEqual(result[1], { channel: "payment-results", role: "subscriber" });
  });
});

describe("readQueueConfig: trims whitespace from channel names", () => {
  let dir;
  before(async () => {
    dir = await makeTempDir();
    await writeConfig(dir, {
      queues: [{ channel: "  order-events  ", role: "publisher" }],
    });
  });
  after(async () => { await fs.rm(dir, { recursive: true }); });

  it("returns trimmed channel name", async () => {
    const result = await readQueueConfig(dir);
    assert.equal(result.length, 1);
    assert.equal(result[0].channel, "order-events");
  });
});

describe("readQueueConfig: skips entries with invalid role", () => {
  let dir;
  before(async () => {
    dir = await makeTempDir();
    await writeConfig(dir, {
      queues: [
        { channel: "order-events", role: "consumer" },  // invalid
        { channel: "valid-channel", role: "subscriber" },
      ],
    });
  });
  after(async () => { await fs.rm(dir, { recursive: true }); });

  it("returns only entries with valid roles", async () => {
    const result = await readQueueConfig(dir);
    assert.equal(result.length, 1);
    assert.equal(result[0].channel, "valid-channel");
  });
});

describe("readQueueConfig: skips entries with empty channel", () => {
  let dir;
  before(async () => {
    dir = await makeTempDir();
    await writeConfig(dir, {
      queues: [
        { channel: "", role: "publisher" },
        { channel: "   ", role: "publisher" },
        { channel: "real-channel", role: "subscriber" },
      ],
    });
  });
  after(async () => { await fs.rm(dir, { recursive: true }); });

  it("returns only entries with non-empty channel", async () => {
    const result = await readQueueConfig(dir);
    assert.equal(result.length, 1);
    assert.equal(result[0].channel, "real-channel");
  });
});

describe("readQueueConfig: invalid JSON", () => {
  let dir;
  before(async () => {
    dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "microservice-kg.config.json"), "{ not valid json", "utf8");
  });
  after(async () => { await fs.rm(dir, { recursive: true }); });

  it("returns [] without throwing", async () => {
    const result = await readQueueConfig(dir);
    assert.deepEqual(result, []);
  });
});

describe("readQueueConfig: missing queues field", () => {
  let dir;
  before(async () => {
    dir = await makeTempDir();
    await writeConfig(dir, { someOtherField: true });
  });
  after(async () => { await fs.rm(dir, { recursive: true }); });

  it("returns [] when queues field is absent", async () => {
    const result = await readQueueConfig(dir);
    assert.deepEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// buildQueueEdges
// ---------------------------------------------------------------------------

function makeService(id, queueBindings) {
  return { id, queueBindings };
}

describe("buildQueueEdges: no bindings", () => {
  it("returns empty edges and channels when services have no queueBindings", () => {
    const { edges, queueChannels } = buildQueueEdges([
      makeService("svc-a", []),
      makeService("svc-b", []),
    ]);
    assert.deepEqual(edges, []);
    assert.deepEqual(queueChannels, []);
  });

  it("returns empty edges and channels when queueBindings field is absent", () => {
    const { edges, queueChannels } = buildQueueEdges([
      { id: "svc-a" },
      { id: "svc-b" },
    ]);
    assert.deepEqual(edges, []);
    assert.deepEqual(queueChannels, []);
  });
});

describe("buildQueueEdges: single publisher, single subscriber", () => {
  let result;
  before(() => {
    result = buildQueueEdges([
      makeService("service-a", [{ channel: "order-events", role: "publisher" }]),
      makeService("service-b", [{ channel: "order-events", role: "subscriber" }]),
    ]);
  });

  it("produces exactly one edge", () => {
    assert.equal(result.edges.length, 1);
  });

  it("edge has correct source and target", () => {
    assert.equal(result.edges[0].sourceServiceId, "service-a");
    assert.equal(result.edges[0].targetServiceId, "service-b");
  });

  it("edge has protocol: queue", () => {
    assert.equal(result.edges[0].protocol, "queue");
  });

  it("edge carries channelName", () => {
    assert.equal(result.edges[0].channelName, "order-events");
  });

  it("edge reasons has type queue-pubsub", () => {
    assert.equal(result.edges[0].reasons.length, 1);
    assert.equal(result.edges[0].reasons[0].type, "queue-pubsub");
    assert.equal(result.edges[0].reasons[0].channelName, "order-events");
    assert.equal(result.edges[0].reasons[0].publisherServiceId, "service-a");
    assert.equal(result.edges[0].reasons[0].subscriberServiceId, "service-b");
  });

  it("edge calls is empty", () => {
    assert.deepEqual(result.edges[0].calls, []);
  });

  it("produces one queueChannel entry", () => {
    assert.equal(result.queueChannels.length, 1);
    assert.equal(result.queueChannels[0].name, "order-events");
    assert.deepEqual(result.queueChannels[0].publishers, ["service-a"]);
    assert.deepEqual(result.queueChannels[0].subscribers, ["service-b"]);
  });
});

describe("buildQueueEdges: fan-out — single publisher, two subscribers", () => {
  let result;
  before(() => {
    result = buildQueueEdges([
      makeService("service-a", [{ channel: "order-events", role: "publisher" }]),
      makeService("service-b", [{ channel: "order-events", role: "subscriber" }]),
      makeService("service-c", [{ channel: "order-events", role: "subscriber" }]),
    ]);
  });

  it("produces two edges (one per subscriber)", () => {
    assert.equal(result.edges.length, 2);
  });

  it("edge IDs cover both subscribers", () => {
    const ids = result.edges.map((e) => e.id).sort();
    assert.deepEqual(ids, ["service-a->service-b", "service-a->service-c"]);
  });

  it("both edges have protocol: queue", () => {
    assert.ok(result.edges.every((e) => e.protocol === "queue"));
  });

  it("queueChannels subscribers list is sorted and contains both", () => {
    assert.equal(result.queueChannels.length, 1);
    assert.deepEqual(result.queueChannels[0].subscribers, ["service-b", "service-c"]);
  });
});

describe("buildQueueEdges: multiple channels", () => {
  let result;
  before(() => {
    result = buildQueueEdges([
      makeService("svc-a", [
        { channel: "channel-x", role: "publisher" },
        { channel: "channel-y", role: "subscriber" },
      ]),
      makeService("svc-b", [
        { channel: "channel-x", role: "subscriber" },
        { channel: "channel-y", role: "publisher" },
      ]),
    ]);
  });

  it("produces two edges (one per channel)", () => {
    assert.equal(result.edges.length, 2);
  });

  it("queueChannels are sorted alphabetically", () => {
    const names = result.queueChannels.map((c) => c.name);
    assert.deepEqual(names, ["channel-x", "channel-y"]);
  });
});

describe("buildQueueEdges: publisher and subscriber are the same service", () => {
  it("does not create a self-edge", () => {
    const { edges } = buildQueueEdges([
      makeService("svc-a", [
        { channel: "loop-channel", role: "publisher" },
        { channel: "loop-channel", role: "subscriber" },
      ]),
    ]);
    assert.deepEqual(edges, []);
  });
});

describe("buildQueueEdges: publisher with no subscribers", () => {
  it("creates a queueChannel entry but no edges", () => {
    const { edges, queueChannels } = buildQueueEdges([
      makeService("svc-a", [{ channel: "orphan-channel", role: "publisher" }]),
    ]);
    assert.deepEqual(edges, []);
    assert.equal(queueChannels.length, 1);
    assert.deepEqual(queueChannels[0].publishers, ["svc-a"]);
    assert.deepEqual(queueChannels[0].subscribers, []);
  });
});
