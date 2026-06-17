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
import {
  findFeatureContext,
  getEndpointContext,
  getMethodContext,
  getRelatedCodeChunks,
} from "./vector-retrieval.mjs";

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
  {
    name: "find_feature_context",
    description:
      "Primary repo-context retrieval tool. Use this first for natural-language questions about feature flow, endpoint ownership, implementation context, impacted logic, or where code lives. It uses KG-first retrieval with vector fallback and should usually be preferred over broad manual repo search for fuzzy repository questions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Feature question, symbol-like query, or implementation prompt." },
        limit: { type: "integer", minimum: 1, description: "Maximum number of top results to include." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_method_context",
    description:
      "Return graph context and supporting code evidence for one exact method id. Prefer this when the method is already known.",
    inputSchema: {
      type: "object",
      properties: {
        methodId: { type: "string", description: "Exact graph method id." },
        limit: { type: "integer", minimum: 1, description: "Maximum number of top results to include." },
      },
      required: ["methodId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_endpoint_context",
    description:
      "Return graph context and supporting code evidence for one endpoint by id, path, or handler method name. Prefer this when the endpoint is already known.",
    inputSchema: {
      type: "object",
      properties: {
        endpointId: { type: "string", description: "Exact graph endpoint id." },
        endpointPath: { type: "string", description: "Resolved endpoint path." },
        methodName: { type: "string", description: "Handler method name if endpoint id/path is not known." },
        limit: { type: "integer", minimum: 1, description: "Maximum number of top results to include." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_related_code_chunks",
    description:
      "Return supporting code evidence for a natural-language query, method id, or endpoint id. Use this when you mainly need code snippets rather than full graph flow context.",
    inputSchema: {
      type: "object",
      properties: {
        queryOrEntityId: { type: "string", description: "Natural-language query, Method:* id, or Endpoint:* id." },
        limit: { type: "integer", minimum: 1, description: "Maximum number of chunks to include." },
      },
      required: ["queryOrEntityId"],
      additionalProperties: false,
    },
  },
  {
    name: "explain_feature_flow",
    description:
      "Alias for find_feature_context with a more natural name. Use this first for fuzzy developer questions like 'Explain lead creation flow end-to-end' or 'Where does retry logic live?'",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language feature or implementation question." },
        limit: { type: "integer", minimum: 1, description: "Maximum number of top results to include." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "explain_method_context",
    description: "Alias for get_method_context. Use when you know the exact method and want graph context plus supporting code evidence.",
    inputSchema: {
      type: "object",
      properties: {
        methodId: { type: "string", description: "Exact graph method id." },
        limit: { type: "integer", minimum: 1, description: "Maximum number of top results to include." },
      },
      required: ["methodId"],
      additionalProperties: false,
    },
  },
  {
    name: "explain_endpoint_context",
    description:
      "Alias for get_endpoint_context. Use when you know the endpoint path, endpoint id, or handler method and want the surrounding implementation flow.",
    inputSchema: {
      type: "object",
      properties: {
        endpointId: { type: "string", description: "Exact graph endpoint id." },
        endpointPath: { type: "string", description: "Resolved endpoint path." },
        methodName: { type: "string", description: "Handler method name if endpoint id/path is not known." },
        limit: { type: "integer", minimum: 1, description: "Maximum number of top results to include." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "find_code_evidence",
    description:
      "Alias for get_related_code_chunks. Use when you mainly want the most relevant implementation snippets for a feature, method, or endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        queryOrEntityId: { type: "string", description: "Natural-language query, Method:* id, or Endpoint:* id." },
        limit: { type: "integer", minimum: 1, description: "Maximum number of chunks to include." },
      },
      required: ["queryOrEntityId"],
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
    case "find_feature_context":
    case "explain_feature_flow":
      return findFeatureContext(store, args);
    case "get_method_context":
    case "explain_method_context":
      return getMethodContext(store, args);
    case "get_endpoint_context":
    case "explain_endpoint_context":
      return getEndpointContext(store, args);
    case "get_related_code_chunks":
    case "find_code_evidence":
      return getRelatedCodeChunks(store, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
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

let lineBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  lineBuffer += chunk;
  const lines = lineBuffer.split("\n");
  lineBuffer = lines.pop();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const message = JSON.parse(trimmed);
      await handleMessage(message);
    } catch (error) {
      send({
        jsonrpc: "2.0",
        error: {
          code: -32700,
          message: error?.message || String(error),
        },
      });
    }
  }
});

process.stdin.resume();
