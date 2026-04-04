#!/usr/bin/env node

import process from "node:process";
import path from "node:path";
import {
  GraphStore,
  getDependencyPath,
  getEdgeDetails,
  getServiceContext,
  getServiceImpact,
  listServices,
} from "./graph-query.mjs";

const DEFAULT_GRAPH_PATH = process.env.MICROSERVICE_KG_GRAPH
  ? path.resolve(process.env.MICROSERVICE_KG_GRAPH)
  : path.resolve(process.cwd(), "output", "service-graph.json");

const store = new GraphStore({ defaultGraphPath: DEFAULT_GRAPH_PATH });

const TOOLS = [
  {
    name: "analyze_workspace",
    description: "Analyze a workspace directory and generate a consolidated microservice graph.",
    inputSchema: {
      type: "object",
      properties: {
        inputDir: { type: "string", description: "Root directory containing multiple services." },
        outputDir: { type: "string", description: "Optional output directory for graph artifacts." },
      },
      required: ["inputDir"],
      additionalProperties: false,
    },
  },
  {
    name: "list_services",
    description: "List all logical services in the currently loaded graph.",
    inputSchema: {
      type: "object",
      properties: {
        includeStats: { type: "boolean", description: "Include endpoint, client, and linkage counts." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "service_context",
    description: "Show incoming and outgoing service links for one service.",
    inputSchema: {
      type: "object",
      properties: {
        serviceId: { type: "string", description: "Logical service id." },
      },
      required: ["serviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "edge_details",
    description: "Show detailed evidence for one directed service edge, including client classes and call sites.",
    inputSchema: {
      type: "object",
      properties: {
        sourceServiceId: { type: "string" },
        targetServiceId: { type: "string" },
      },
      required: ["sourceServiceId", "targetServiceId"],
      additionalProperties: false,
    },
  },
  {
    name: "dependency_path",
    description: "Find a service-to-service path between two services.",
    inputSchema: {
      type: "object",
      properties: {
        sourceServiceId: { type: "string" },
        targetServiceId: { type: "string" },
        maxDepth: {
          type: "integer",
          minimum: 1,
          description: "Optional hop limit. If omitted, traversal uses the full logical graph depth.",
        },
        direction: {
          type: "string",
          enum: ["downstream", "upstream"],
          description: "Use downstream for normal call direction or upstream to walk reverse dependencies.",
        },
      },
      required: ["sourceServiceId", "targetServiceId"],
      additionalProperties: false,
    },
  },
  {
    name: "service_impact",
    description: "Traverse service-level blast radius from one service.",
    inputSchema: {
      type: "object",
      properties: {
        serviceId: { type: "string" },
        direction: {
          type: "string",
          enum: ["downstream", "upstream"],
        },
        maxDepth: {
          type: "integer",
          minimum: 1,
          description: "Optional hop limit. If omitted, traversal uses the full logical graph depth.",
        },
      },
      required: ["serviceId"],
      additionalProperties: false,
    },
  },
];

async function dispatchToolCall(name, args = {}) {
  switch (name) {
    case "analyze_workspace":
      return store.analyzeAndLoad(args);
    case "list_services":
      return listServices(store, args);
    case "service_context":
      return getServiceContext(store, args);
    case "edge_details":
      return getEdgeDetails(store, args);
    case "dependency_path":
      return getDependencyPath(store, args);
    case "service_impact":
      return getServiceImpact(store, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(message) {
  const json = JSON.stringify(message);
  const payload = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
  process.stdout.write(payload);
}

function success(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function failure(id, error) {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: error?.message || String(error),
    },
  });
}

async function handleMessage(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    success(id, {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "microservice-kg",
        version: "0.1.0",
      },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "ping") {
    success(id, {});
    return;
  }

  if (method === "tools/list") {
    success(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    try {
      const result = await dispatchToolCall(params?.name, params?.arguments || {});
      success(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      });
    } catch (error) {
      success(id, {
        isError: true,
        content: [
          {
            type: "text",
            text: error?.stack || error?.message || String(error),
          },
        ],
      });
    }
    return;
  }

  if (id !== undefined) {
    failure(id, new Error(`Unsupported method: ${method}`));
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (true) {
    const separatorIndex = buffer.indexOf("\r\n\r\n");
    if (separatorIndex === -1) {
      return;
    }

    const headerText = buffer.slice(0, separatorIndex).toString("utf8");
    const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) {
      buffer = buffer.slice(separatorIndex + 4);
      continue;
    }

    const contentLength = Number(lengthMatch[1]);
    const totalLength = separatorIndex + 4 + contentLength;
    if (buffer.length < totalLength) {
      return;
    }

    const body = buffer.slice(separatorIndex + 4, totalLength).toString("utf8");
    buffer = buffer.slice(totalLength);

    try {
      const message = JSON.parse(body);
      await handleMessage(message);
    } catch (error) {
      if (typeof error !== "undefined") {
        send({
          jsonrpc: "2.0",
          error: {
            code: -32700,
            message: error?.message || String(error),
          },
        });
      }
    }
  }
});

process.stdin.resume();
