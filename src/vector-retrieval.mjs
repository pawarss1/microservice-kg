import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_COLLECTION = process.env.KG_VECTOR_COLLECTION || "lead_code_chunks";
const DEFAULT_LIMIT = Number(process.env.KG_VECTOR_LIMIT || 5);
const RETRIEVE_COMMAND = process.env.KG_VECTOR_RETRIEVE_CMD || "kg-retrieve";
const PYTHON_COMMAND = process.env.KG_VECTOR_PYTHON || "python3";
const INDEXER_SRC = process.env.KG_VECTOR_INDEXER_SRC || "";
const CHROMA_PATH = process.env.KG_VECTOR_CHROMA_PATH || "";

export async function findFeatureContext(store, { query, limit = DEFAULT_LIMIT } = {}) {
  if (!query || typeof query !== "string") {
    throw new Error("query is required");
  }
  await store.ensureGraph();
  return runRetriever({
    graphPath: store.graphPath,
    query,
    limit,
  });
}

export async function getMethodContext(store, { methodId, limit = DEFAULT_LIMIT } = {}) {
  if (!methodId || typeof methodId !== "string") {
    throw new Error("methodId is required");
  }

  const graph = await store.ensureGraph();
  const resolved = resolveMethodById(graph, methodId);
  if (!resolved) {
    throw new Error(`Unknown methodId: ${methodId}`);
  }

  const query = `${resolved.method.className} ${resolved.method.name}`;
  const result = await runRetriever({
    graphPath: store.graphPath,
    query,
    limit,
  });

  return {
    requestedMethodId: methodId,
    serviceId: resolved.service.id,
    ...result,
  };
}

export async function getEndpointContext(
  store,
  { endpointPath, endpointId, methodName, limit = DEFAULT_LIMIT } = {},
) {
  const graph = await store.ensureGraph();
  const resolved = resolveEndpoint(graph, { endpointPath, endpointId, methodName });
  if (!resolved) {
    throw new Error("Unable to resolve endpoint. Provide endpointId, endpointPath, or methodName.");
  }

  const query = `${resolved.endpoint.httpMethod} ${resolved.endpoint.fullPath} ${resolved.endpoint.methodName}`;
  const result = await runRetriever({
    graphPath: store.graphPath,
    query,
    limit,
  });

  return {
    requestedEndpointId: resolved.endpoint.id,
    serviceId: resolved.service.id,
    ...result,
  };
}

export async function getRelatedCodeChunks(store, { queryOrEntityId, limit = DEFAULT_LIMIT } = {}) {
  if (!queryOrEntityId || typeof queryOrEntityId !== "string") {
    throw new Error("queryOrEntityId is required");
  }

  const graph = await store.ensureGraph();
  let query = queryOrEntityId;

  if (queryOrEntityId.startsWith("Method:")) {
    const resolvedMethod = resolveMethodById(graph, queryOrEntityId);
    if (!resolvedMethod) {
      throw new Error(`Unknown methodId: ${queryOrEntityId}`);
    }
    query = `${resolvedMethod.method.className} ${resolvedMethod.method.name}`;
  } else if (queryOrEntityId.startsWith("Endpoint:")) {
    const resolvedEndpoint = resolveEndpoint(graph, { endpointId: queryOrEntityId });
    if (!resolvedEndpoint) {
      throw new Error(`Unknown endpointId: ${queryOrEntityId}`);
    }
    query = `${resolvedEndpoint.endpoint.httpMethod} ${resolvedEndpoint.endpoint.fullPath} ${resolvedEndpoint.endpoint.methodName}`;
  }

  const result = await runRetriever({
    graphPath: store.graphPath,
    query,
    limit,
  });

  return {
    query: queryOrEntityId,
    evidence: result.evidence || [],
    summary: result.summary,
    confidence: result.confidence,
    nextSuggestions: result.nextSuggestions || [],
  };
}

async function runRetriever({ graphPath, query, limit }) {
  if (!graphPath) {
    throw new Error("Graph path is not configured");
  }
  if (!CHROMA_PATH) {
    throw new Error("KG_VECTOR_CHROMA_PATH is not configured");
  }

  const args = [
    "--graph-path",
    graphPath,
    "--chroma-path",
    CHROMA_PATH,
    "--collection",
    DEFAULT_COLLECTION,
    "--query",
    query,
    "--limit",
    String(limit || DEFAULT_LIMIT),
  ];

  const { command, commandArgs, env } = buildRetrieverInvocation(args);
  const { stdout, stderr } = await execFileAsync(command, commandArgs, {
    env,
    maxBuffer: 20 * 1024 * 1024,
  });

  const output = stdout?.trim();
  if (!output) {
    throw new Error(stderr?.trim() || "Retriever returned empty output");
  }

  try {
    return JSON.parse(output);
  } catch (error) {
    const detail = stderr?.trim() ? ` STDERR: ${stderr.trim()}` : "";
    throw new Error(`Retriever returned invalid JSON.${detail}\n${output}`);
  }
}

function buildRetrieverInvocation(args) {
  if (INDEXER_SRC) {
    const pythonPathParts = [INDEXER_SRC];
    if (process.env.PYTHONPATH) {
      pythonPathParts.push(process.env.PYTHONPATH);
    }

    const script = `
import sys
from kg_vector_indexer.cli import retrieve_main
sys.argv = ['kg-retrieve', *${JSON.stringify(args)}]
retrieve_main()
`;
    return {
      command: PYTHON_COMMAND,
      commandArgs: ["-c", script],
      env: {
        ...process.env,
        PYTHONPATH: pythonPathParts.join(process.platform === "win32" ? ";" : ":"),
      },
    };
  }

  return {
    command: RETRIEVE_COMMAND,
    commandArgs: args,
    env: process.env,
  };
}

function resolveMethodById(graph, methodId) {
  for (const service of graph.services || []) {
    const method = (service.methods || []).find((candidate) => candidate.id === methodId);
    if (method) {
      return { service, method };
    }
  }
  return null;
}

function resolveEndpoint(graph, { endpointPath, endpointId, methodName }) {
  for (const service of graph.services || []) {
    const endpoint = (service.endpoints || []).find((candidate) => {
      if (endpointId && candidate.id === endpointId) return true;
      if (endpointPath && candidate.fullPath === endpointPath) return true;
      if (methodName && candidate.methodName === methodName) return true;
      return false;
    });
    if (endpoint) {
      return { service, endpoint };
    }
  }
  return null;
}
