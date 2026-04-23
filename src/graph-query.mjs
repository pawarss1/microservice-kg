import fs from "node:fs/promises";
import path from "node:path";
import { analyzeWorkspace, writeGraphArtifacts } from "./analyzer.mjs";

export class GraphStore {
  constructor(options = {}) {
    this.defaultGraphPath = options.defaultGraphPath || null;
    this.graph = null;
    this.graphPath = null;
  }

  async loadGraph(graphPath = this.defaultGraphPath) {
    if (!graphPath) {
      throw new Error("No graph path configured");
    }
    const resolvedPath = path.resolve(graphPath);
    const graph = JSON.parse(await fs.readFile(resolvedPath, "utf8"));
    this.graph = graph;
    this.graphPath = resolvedPath;
    return graph;
  }

  async ensureGraph() {
    if (this.graph) {
      return this.graph;
    }
    return this.loadGraph();
  }

  async analyzeAndLoad({ inputDir, outputDir }) {
    const resolvedInput = path.resolve(inputDir);
    const resolvedOutput = outputDir
      ? path.resolve(outputDir)
      : path.join(resolvedInput, ".microservice-kg");
    const graph = await analyzeWorkspace(resolvedInput);
    await writeGraphArtifacts(graph, resolvedOutput);
    const graphPath = path.join(resolvedOutput, "service-graph.json");
    this.graph = graph;
    this.graphPath = graphPath;
    return {
      inputDir: resolvedInput,
      outputDir: resolvedOutput,
      graphPath,
      serviceCount: graph.serviceCount,
      edgeCount: graph.serviceEdges.length,
    };
  }
}

export async function listServices(store, { includeStats = true } = {}) {
  const graph = await store.ensureGraph();
  const grouped = groupServices(graph);
  const queueChannels = graph.queueChannels || [];

  const results = Object.values(grouped)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((service) => {
      const base = {
        id: service.id,
        name: service.id,
        roots: service.roots.sort((a, b) => a.localeCompare(b)),
      };
      if (!includeStats) {
        return base;
      }
      return {
        ...base,
        endpointCount: service.endpointCount,
        clientCount: service.clientCount,
        methodInteractionCount: service.methodInteractionCount,
        outgoingServices: uniqueSorted(
          graph.serviceEdges
            .filter((edge) => edge.sourceServiceId === service.id)
            .map((edge) => edge.targetServiceId),
        ),
        incomingServices: uniqueSorted(
          graph.serviceEdges
            .filter((edge) => edge.targetServiceId === service.id)
            .map((edge) => edge.sourceServiceId),
        ),
        outgoingQueueChannels: uniqueSorted(
          queueChannels
            .filter((ch) => ch.publishers.includes(service.id))
            .map((ch) => ch.name),
        ),
        incomingQueueChannels: uniqueSorted(
          queueChannels
            .filter((ch) => ch.subscribers.includes(service.id))
            .map((ch) => ch.name),
        ),
      };
    });

  return {
    graphPath: store.graphPath,
    serviceCount: results.length,
    services: results,
  };
}

export async function getServiceContext(store, { serviceId }) {
  const graph = await store.ensureGraph();
  const grouped = groupServices(graph);
  const service = grouped[serviceId];
  if (!service) {
    throw new Error(`Unknown service: ${serviceId}`);
  }

  const outgoing = graph.serviceEdges
    .filter((edge) => edge.sourceServiceId === serviceId)
    .map(summarizeEdge);
  const incoming = graph.serviceEdges
    .filter((edge) => edge.targetServiceId === serviceId)
    .map(summarizeEdge);

  return {
    service: {
      id: service.id,
      roots: service.roots.sort((a, b) => a.localeCompare(b)),
      endpointCount: service.endpointCount,
      clientCount: service.clientCount,
      methodInteractionCount: service.methodInteractionCount,
    },
    outgoing,
    incoming,
  };
}

export async function getEdgeDetails(store, { sourceServiceId, targetServiceId }) {
  const graph = await store.ensureGraph();
  const edge = graph.serviceEdges.find(
    (candidate) =>
      candidate.sourceServiceId === sourceServiceId
      && candidate.targetServiceId === targetServiceId,
  );
  if (!edge) {
    throw new Error(`Unknown edge: ${sourceServiceId} -> ${targetServiceId}`);
  }

  return {
    id: edge.id,
    sourceServiceId: edge.sourceServiceId,
    targetServiceId: edge.targetServiceId,
    protocol: edge.protocol,
    reasons: edge.reasons,
    calls: edge.calls,
  };
}

export async function getDependencyPath(
  store,
  { sourceServiceId, targetServiceId, maxDepth, direction = "downstream" },
) {
  const graph = await store.ensureGraph();
  const effectiveMaxDepth = normalizeMaxDepth(maxDepth, graph);
  const adjacency = buildAdjacency(graph, direction);
  const queue = [{ node: sourceServiceId, path: [sourceServiceId] }];
  const visited = new Set([sourceServiceId]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.node === targetServiceId) {
      return {
        found: true,
        direction,
        path: current.path,
        depth: current.path.length - 1,
        maxDepth: effectiveMaxDepth,
      };
    }

    if (current.path.length - 1 >= effectiveMaxDepth) {
      continue;
    }

    for (const neighbor of adjacency.get(current.node) || []) {
      if (visited.has(neighbor)) {
        continue;
      }
      visited.add(neighbor);
      queue.push({
        node: neighbor,
        path: [...current.path, neighbor],
      });
    }
  }

  return {
    found: false,
    direction,
    path: [],
    depth: null,
    maxDepth: effectiveMaxDepth,
  };
}

export async function getServiceImpact(
  store,
  { serviceId, direction = "downstream", maxDepth },
) {
  const graph = await store.ensureGraph();
  const effectiveMaxDepth = normalizeMaxDepth(maxDepth, graph);
  const adjacency = buildAdjacency(graph, direction);
  const queue = [{ node: serviceId, depth: 0 }];
  const visited = new Set([serviceId]);
  const results = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth >= effectiveMaxDepth) {
      continue;
    }

    for (const neighbor of adjacency.get(current.node) || []) {
      if (visited.has(neighbor)) {
        continue;
      }
      visited.add(neighbor);
      const nextDepth = current.depth + 1;
      results.push({
        serviceId: neighbor,
        depth: nextDepth,
      });
      queue.push({
        node: neighbor,
        depth: nextDepth,
      });
    }
  }

  return {
    serviceId,
    direction,
    maxDepth: effectiveMaxDepth,
    impactedServices: results.sort(
      (left, right) => left.depth - right.depth || left.serviceId.localeCompare(right.serviceId),
    ),
  };
}

function summarizeEdge(edge) {
  const base = {
    id: edge.id,
    sourceServiceId: edge.sourceServiceId,
    targetServiceId: edge.targetServiceId,
    protocol: edge.protocol,
  };
  if (edge.protocol === "queue") {
    return { ...base, channelName: edge.channelName };
  }
  return {
    ...base,
    clientClasses: uniqueSorted(edge.reasons.map((reason) => reason.clientClassName)),
    callCount: edge.calls.length,
  };
}

function buildAdjacency(graph, direction) {
  const adjacency = new Map();
  const ids = uniqueSorted(graph.services.map((service) => service.id));
  for (const id of ids) {
    adjacency.set(id, new Set());
  }

  for (const edge of graph.serviceEdges) {
    if (direction === "upstream") {
      adjacency.get(edge.targetServiceId)?.add(edge.sourceServiceId);
    } else {
      adjacency.get(edge.sourceServiceId)?.add(edge.targetServiceId);
    }
  }

  return adjacency;
}

function groupServices(graph) {
  const grouped = {};
  for (const service of graph.services) {
    if (!grouped[service.id]) {
      grouped[service.id] = {
        id: service.id,
        roots: [],
        endpointCount: 0,
        clientCount: 0,
        methodInteractionCount: 0,
      };
    }
    grouped[service.id].roots.push(service.relativeRootDir || service.rootDir || service.id);
    grouped[service.id].endpointCount += service.endpoints?.length || 0;
    grouped[service.id].clientCount += service.clients?.length || 0;
    grouped[service.id].methodInteractionCount += service.methodInteractions?.length || 0;
  }
  return grouped;
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function normalizeMaxDepth(value, graph) {
  const graphWideDepth = Math.max(1, uniqueSorted(graph.services.map((service) => service.id)).length);
  if (value === undefined || value === null || value === "") {
    return graphWideDepth;
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 1) {
    return graphWideDepth;
  }
  return Math.floor(numericValue);
}
