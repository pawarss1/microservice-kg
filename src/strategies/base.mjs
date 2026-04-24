/**
 * @file base.mjs
 * Shared utilities and contracts for all language strategies.
 *
 * Each language strategy must export an object conforming to the LanguageStrategy interface:
 *
 * @typedef {Object} LanguageStrategy
 * @property {string}   id               - Unique language identifier (e.g. 'java-spring', 'nodejs', 'python')
 * @property {string[]} indicatorFiles   - Well-known filenames that signal this language
 * @property {function(string): Promise<string[]>} discoverServiceRoots
 *   Resolve all service root directories within a workspace.
 *   @param {string} rootDir - Absolute path to the workspace root
 *   @returns {Promise<string[]>} Sorted list of absolute service root paths
 * @property {function(string, string): Promise<Object|null>} analyzeService
 *   Extract full service metadata for one service root.
 *   @param {string} serviceRoot  - Absolute path to the service directory
 *   @param {string} workspaceRoot - Absolute path to the workspace root (for relative paths)
 *   @returns {Promise<ServiceResult|null>}
 */

import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.mjs";

export const IGNORED_DIR_NAMES = new Set([
  ".git",
  ".idea",
  ".gradle",
  ".microservice-kg",
  ".claude",
  "build",
  "dist",
  "node_modules",
  "out",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
]);

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function listFiles(rootDir, predicate) {
  const files = [];
  if (!(await pathExists(rootDir))) {
    return files;
  }

  async function walk(currentDir) {
    let dirents;
    try {
      dirents = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (dirent.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(dirent.name)) {
          continue;
        }
        await walk(path.join(currentDir, dirent.name));
      } else if (predicate(dirent)) {
        files.push(path.join(currentDir, dirent.name));
      }
    }
  }

  await walk(rootDir);
  return files;
}

export async function walkDirectories(rootDir, visitor) {
  let dirents;
  try {
    dirents = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  const shouldStop = await visitor(rootDir, dirents);
  if (shouldStop) {
    return;
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) {
      continue;
    }
    if (IGNORED_DIR_NAMES.has(dirent.name)) {
      continue;
    }
    await walkDirectories(path.join(rootDir, dirent.name), visitor);
  }
}

// ---------------------------------------------------------------------------
// Data utilities
// ---------------------------------------------------------------------------

export function dedupeBy(values, keyFn) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

// ---------------------------------------------------------------------------
// Path and string utilities
// ---------------------------------------------------------------------------

export function stripQuotes(value) {
  return String(value || "").replace(/^['"]|['"]$/g, "");
}

export function normalizePath(value) {
  if (!value) {
    return "";
  }

  let result = stripQuotes(value.trim());
  if (!result) {
    return "";
  }

  result = result.replace(/^https?:\/\/[^/]+/i, "");
  if (!result.startsWith("/")) {
    result = `/${result}`;
  }
  result = result.replace(/\/+/g, "/");
  result = result.replace(/\{[^}]+\}/g, "{}");
  if (result.length > 1 && result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

export function joinPaths(basePath, pathValue) {
  const normalizedBase = normalizePath(basePath || "");
  const normalizedPath = normalizePath(pathValue || "");
  if (!normalizedBase) {
    return normalizedPath || "/";
  }
  if (!normalizedPath) {
    return normalizedBase || "/";
  }
  return normalizePath(`${normalizedBase}/${normalizedPath}`);
}

export function resolveConfigValue(rawValue, propertyMap) {
  if (!rawValue) {
    return rawValue;
  }

  let result = rawValue;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const replaced = result.replace(/\$\{([^}:]+)(?::[^}]*)?\}/g, (match, key) => {
      return propertyMap[key] ?? match;
    });
    if (replaced === result) {
      break;
    }
    result = replaced;
  }
  return stripQuotes(result);
}

/** Strips Java generic and array notation to get a simple type name. Safe no-op for non-Java types. */
export function sanitizeJavaType(value) {
  return String(value || "")
    .replace(/<.*>/g, "")
    .replace(/\[\]/g, "")
    .split(".")
    .pop()
    .trim();
}

// ---------------------------------------------------------------------------
// Service alias helpers
// ---------------------------------------------------------------------------

export function normalizeAlias(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Words too generic to be useful as standalone aliases
const GENERIC_ALIAS_WORDS = new Set([
  "api", "app", "bank", "base", "connect", "core", "data", "module",
  "net", "server", "service", "util", "utils", "web",
]);

export function deriveServiceAliases(values) {
  const aliases = new Set();
  for (const value of values.filter(Boolean)) {
    const normalized = normalizeAlias(value);
    if (!normalized) {
      continue;
    }
    aliases.add(normalized);
    const strippedPrefixes = normalized.replace(/^(fin|cf)-/, "");
    aliases.add(strippedPrefixes);
    const strippedService = strippedPrefixes.replace(/-service$/, "");
    aliases.add(strippedService);
    aliases.add(`${strippedService}-service`);

    // Add meaningful sub-component suffix aliases from the normalized name.
    // e.g. "bank-connect-enrichments" → also add "enrichments"
    //      "bank-connect-aa-fiu-module" → also add "fiu-module", "fiu"
    const parts = normalized.split("-").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const firstPart = parts[i];
      if (GENERIC_ALIAS_WORDS.has(firstPart) || firstPart.length < 3) {
        continue;
      }
      const suffix = parts.slice(i).join("-");
      aliases.add(suffix);
    }
  }
  return Array.from(aliases).filter(Boolean).sort((left, right) => left.localeCompare(right));
}

// ---------------------------------------------------------------------------
// Service edge building (language-agnostic)
// Clients from any strategy must provide at minimum:
//   { httpMethod, fullPath } and optionally { feignName, clientName,
//     urlExpression, resolvedBaseUrl, baseUrl, pathExpression,
//     resolvedPath, path, callSites }
// Endpoints must provide: { httpMethod, fullPath }
// ---------------------------------------------------------------------------

export function buildServiceEdges(services) {
  const endpointsByMethodAndPath = new Map();
  const aliasIndex = new Map();

  for (const service of services) {
    for (const alias of service.aliases) {
      aliasIndex.set(alias, service.id);
    }
    for (const endpoint of service.endpoints) {
      const epPath = endpoint.fullPath || endpoint.path || "";
      const key = `${endpoint.httpMethod}:${normalizePath(epPath)}`;
      if (!endpointsByMethodAndPath.has(key)) {
        endpointsByMethodAndPath.set(key, []);
      }
      endpointsByMethodAndPath.get(key).push({ serviceId: service.id, endpoint });
    }
  }

  const edges = new Map();

  for (const service of services) {
    for (const client of service.clients) {
      const targetServiceId = resolveTargetServiceId(client, services, aliasIndex, endpointsByMethodAndPath);
      if (!targetServiceId || targetServiceId === service.id) {
        continue;
      }

      const provider = resolveProviderEndpoint(targetServiceId, client, services, endpointsByMethodAndPath);
      const callSites = client.callSites || findCallSitesForClientMethod(service, client);
      const edgeKey = `${service.id}->${targetServiceId}`;
      if (!edges.has(edgeKey)) {
        edges.set(edgeKey, {
          id: edgeKey,
          sourceServiceId: service.id,
          targetServiceId,
          protocol: "http",
          reasons: [],
          calls: [],
        });
      }

      const edge = edges.get(edgeKey);
      const clientPath = client.fullPath || client.path || "";
      const clientHttpMethod = client.httpMethod || client.method || "GET";
      edge.reasons.push({
        type: client.feignName ? "feign-client" : "http-client",
        clientClassName: client.className || null,
        clientMethodName: client.methodName || client.clientName || null,
        httpMethod: clientHttpMethod,
        path: clientPath,
      });
      edge.calls.push({
        httpMethod: clientHttpMethod,
        path: clientPath,
        sourceClassName: client.className || null,
        sourceMethodName: client.methodName || client.clientName || null,
        sourceFilePath: client.filePath,
        callSites,
        provider: provider
          ? {
              targetClassName: provider.className || null,
              targetMethodName: provider.methodName || null,
              targetFilePath: provider.filePath,
              targetLine: provider.line,
            }
          : null,
      });
    }
  }

  return Array.from(edges.values())
    .map((edge) => ({
      ...edge,
      reasons: dedupeBy(edge.reasons, (reason) => JSON.stringify(reason)),
      calls: dedupeBy(edge.calls, (call) => JSON.stringify(call)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function findCallSitesForClientMethod(service, clientMethod) {
  if (clientMethod.callSites) {
    return clientMethod.callSites;
  }
  const sites = [];
  const fieldsByClass = new Map();
  for (const field of service.fields) {
    if (!fieldsByClass.has(field.className)) {
      fieldsByClass.set(field.className, []);
    }
    fieldsByClass.get(field.className).push(field);
  }

  for (const method of service.methods) {
    const classFields = fieldsByClass.get(method.className) || [];
    const receiverNames = classFields
      .filter((field) => sanitizeJavaType(field.type) === (clientMethod.className || ""))
      .map((field) => field.name);

    for (const call of (method.calls || [])) {
      if (
        call.receiver &&
        receiverNames.includes(call.receiver) &&
        call.method === clientMethod.methodName
      ) {
        sites.push({
          className: method.className,
          methodName: method.name,
          filePath: method.filePath,
          line: call.line,
        });
      }
    }
  }

  return sites;
}

function resolveProviderEndpoint(targetServiceId, client, services, endpointsByMethodAndPath) {
  const clientPath = client.fullPath || client.path || "";
  const clientHttpMethod = client.httpMethod || client.method || "GET";
  const key = `${clientHttpMethod}:${normalizePath(clientPath)}`;
  const providerEntries = endpointsByMethodAndPath.get(key) || [];
  const provider = providerEntries.find((entry) => entry.serviceId === targetServiceId);
  if (provider?.endpoint) {
    return provider.endpoint;
  }

  const targetService = services.find((service) => service.id === targetServiceId);
  if (!targetService) {
    return null;
  }

  const normalizedClientPath = normalizePath(clientPath);
  return targetService.endpoints.find((endpoint) => {
    const epHttpMethod = endpoint.httpMethod || endpoint.method || "GET";
    if (epHttpMethod !== clientHttpMethod) {
      return false;
    }
    const endpointPath = normalizePath(endpoint.fullPath || endpoint.path || "");
    return (
      normalizedClientPath.endsWith(endpointPath)
      || endpointPath.endsWith(normalizedClientPath)
    );
  }) || null;
}

function resolveTargetServiceId(client, services, aliasIndex, endpointsByMethodAndPath) {
  const candidateStrings = [
    client.feignName,
    client.clientName,
    client.urlExpression,
    client.resolvedBaseUrl,
    client.baseUrl,
    client.pathExpression,
    client.resolvedPath,
    client.path,
  ].filter(Boolean);

  const candidateScores = new Map();
  for (const candidateString of candidateStrings) {
    // Normalize to hyphen-separated form so underscore-based variable names
    // (e.g. BANK_CONNECT_BASE_URL → bank-connect-base-url) can match aliases.
    const haystack = normalizeAlias(candidateString);
    for (const service of services) {
      for (const alias of service.aliases) {
        if (haystack.includes(alias)) {
          candidateScores.set(service.id, (candidateScores.get(service.id) || 0) + alias.length);
        }
      }
    }
  }

  if (candidateScores.size > 0) {
    return Array.from(candidateScores.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0];
  }

  // Exact path match
  const clientPath = client.fullPath || client.path || "";
  const clientHttpMethod = client.httpMethod || client.method || "GET";
  const normalizedClientPath = normalizePath(clientPath);
  const key = `${clientHttpMethod}:${normalizedClientPath}`;
  const providers = endpointsByMethodAndPath.get(key) || [];
  if (providers.length === 1) {
    return providers[0].serviceId;
  }

  // Partial path match: find the service whose endpoint path is a prefix of the client path.
  // This handles cases where the client calls a sub-resource of a registered router prefix
  // (e.g. client calls /bank-connect/v1/internal/create_or_update_template and the service
  // has a DRF-registered endpoint at /bank-connect/v1/internal/).
  if (normalizedClientPath && normalizedClientPath !== "/") {
    const prefixMatches = new Map(); // serviceId → longest matching endpoint prefix length
    for (const service of services) {
      for (const endpoint of service.endpoints) {
        const epMethod = endpoint.httpMethod || "GET";
        if (epMethod !== clientHttpMethod && clientHttpMethod !== "GET") continue;
        const epPath = normalizePath(endpoint.fullPath || endpoint.path || "");
        if (epPath.length < 4) continue; // skip root-level catch-alls
        if (normalizedClientPath.startsWith(epPath)) {
          const prev = prefixMatches.get(service.id) || 0;
          if (epPath.length > prev) {
            prefixMatches.set(service.id, epPath.length);
          }
        }
      }
    }
    if (prefixMatches.size === 1) {
      return Array.from(prefixMatches.keys())[0];
    }
    if (prefixMatches.size > 1) {
      // Pick the service with the longest (most specific) matching prefix
      return Array.from(prefixMatches.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    }
  }

  const feignOrClientName = client.feignName || client.clientName || "";
  return aliasIndex.get(normalizeAlias(feignOrClientName)) || null;
}

// ---------------------------------------------------------------------------
// Queue binding helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Queue string helpers
// ---------------------------------------------------------------------------

/**
 * Extract quoted string values from a comma-separated list.
 * Works for both Python ("t1", "t2") and Java ("t1", "t2") list literals.
 * e.g. '"topic1", "topic2"' → ['topic1', 'topic2']
 */
export function extractStringList(text) {
  const results = [];
  for (const m of text.matchAll(/['"`]([^'"`]+)['"`]/g)) {
    results.push(m[1]);
  }
  return results;
}

/**
 * Merge auto-detected queue bindings with manually configured ones.
 * Deduplicates by (channel, role) pair. Detected bindings come first so
 * manual entries act as overrides only for genuinely new (channel, role) pairs.
 */
export function mergeQueueBindings(detected, manual) {
  const seen = new Set();
  const result = [];
  for (const binding of [...detected, ...manual]) {
    const key = `${binding.channel}:${binding.role}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(binding);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------

/**
 * Read queue channel bindings from an optional per-service config file.
 * Returns an array of { channel, role } objects.
 * Missing or malformed config files return [] without throwing.
 *
 * @param {string} serviceRoot - Absolute path to the service directory
 * @returns {Promise<Array<{channel: string, role: string}>>}
 */
export async function readQueueConfig(serviceRoot) {
  const configPath = path.join(serviceRoot, "microservice-kg.config.json");
  let raw;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    // File absent — not an error
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log("warn", `Invalid JSON in microservice-kg.config.json at ${serviceRoot} — skipping queue bindings`);
    return [];
  }

  if (!Array.isArray(parsed.queues)) {
    return [];
  }

  const bindings = [];
  for (const entry of parsed.queues) {
    const channel = typeof entry.channel === "string" ? entry.channel.trim() : "";
    const role = entry.role;

    if (!channel) {
      log("warn", `Queue binding with empty channel skipped in ${configPath}`);
      continue;
    }
    if (role !== "publisher" && role !== "subscriber") {
      log("warn", `Queue binding with invalid role "${role}" skipped in ${configPath}`);
      continue;
    }
    bindings.push({ channel, role });
  }

  return bindings;
}

/**
 * Build queue-protocol service edges from all services' queueBindings.
 * Creates one directed edge per (publisher × subscriber) pair per channel.
 * Also returns a queueChannels summary array.
 *
 * @param {Object[]} services - Array of ServiceResult objects (each may have queueBindings[])
 * @returns {{ edges: Object[], queueChannels: Object[] }}
 */
export function buildQueueEdges(services) {
  // Group publishers and subscribers by channel name
  const channelMap = new Map(); // channel → { publishers: Set, subscribers: Set }

  for (const service of services) {
    for (const binding of (service.queueBindings || [])) {
      if (!channelMap.has(binding.channel)) {
        channelMap.set(binding.channel, { publishers: new Set(), subscribers: new Set() });
      }
      const entry = channelMap.get(binding.channel);
      if (binding.role === "publisher") {
        entry.publishers.add(service.id);
      } else {
        entry.subscribers.add(service.id);
      }
    }
  }

  const edges = [];
  const queueChannels = [];

  for (const [channelName, { publishers, subscribers }] of channelMap) {
    const publishersSorted = Array.from(publishers).sort((a, b) => a.localeCompare(b));
    const subscribersSorted = Array.from(subscribers).sort((a, b) => a.localeCompare(b));

    queueChannels.push({
      name: channelName,
      publishers: publishersSorted,
      subscribers: subscribersSorted,
    });

    for (const publisherId of publishersSorted) {
      for (const subscriberId of subscribersSorted) {
        if (publisherId === subscriberId) {
          continue;
        }
        edges.push({
          id: `${publisherId}->${subscriberId}`,
          sourceServiceId: publisherId,
          targetServiceId: subscriberId,
          protocol: "queue",
          channelName,
          reasons: [
            {
              type: "queue-pubsub",
              channelName,
              publisherServiceId: publisherId,
              subscriberServiceId: subscriberId,
            },
          ],
          calls: [],
        });
      }
    }
  }

  queueChannels.sort((a, b) => a.name.localeCompare(b.name));

  return { edges, queueChannels };
}

// ---------------------------------------------------------------------------
// Summary rendering
// ---------------------------------------------------------------------------

export function renderSummary(graph) {
  const httpEdges = graph.serviceEdges.filter((e) => e.protocol !== "queue");
  const queueEdges = graph.serviceEdges.filter((e) => e.protocol === "queue");
  const queueChannels = graph.queueChannels || [];

  const lines = [
    "# Microservice KG Summary",
    "",
    `- Generated at: ${graph.generatedAt}`,
    `- Input directory: ${graph.inputDir}`,
    `- Language: ${graph.language || "unknown"}`,
    `- Services discovered: ${graph.serviceCount}`,
    `- Service edges discovered: ${graph.serviceEdges.length}`,
    `- Queue channels: ${queueChannels.length}`,
    "",
    "## Service Graph",
    "",
    "```mermaid",
    "graph LR",
  ];

  for (const edge of httpEdges) {
    lines.push(
      `  ${safeMermaidId(edge.sourceServiceId)}["${edge.sourceServiceId}"] -->|HTTP| ${safeMermaidId(edge.targetServiceId)}["${edge.targetServiceId}"]`,
    );
  }
  for (const edge of queueEdges) {
    lines.push(
      `  ${safeMermaidId(edge.sourceServiceId)}["${edge.sourceServiceId}"] -.->|queue: ${edge.channelName}| ${safeMermaidId(edge.targetServiceId)}["${edge.targetServiceId}"]`,
    );
  }
  lines.push("```", "");

  if (queueChannels.length > 0) {
    lines.push("## Queue Channels", "");
    for (const ch of queueChannels) {
      lines.push(`### ${ch.name}`);
      lines.push(`- Publishers: ${ch.publishers.length > 0 ? ch.publishers.join(", ") : "(none)"}`);
      lines.push(`- Subscribers: ${ch.subscribers.length > 0 ? ch.subscribers.join(", ") : "(none)"}`);
      lines.push("");
    }
  }

  lines.push("## Services", "");

  for (const service of graph.services) {
    lines.push(`### ${service.id}`);
    lines.push(`- Root: ${service.relativeRootDir}`);
    lines.push(`- Endpoints: ${service.endpoints.length}`);
    lines.push(`- Clients: ${service.clients.length}`);
    lines.push(`- Method interactions: ${service.methodInteractions.length}`);
    const outgoingEdges = graph.serviceEdges.filter((edge) => edge.sourceServiceId === service.id);
    if (outgoingEdges.length > 0) {
      lines.push(`- Outgoing services: ${outgoingEdges.map((edge) => edge.targetServiceId).join(", ")}`);
    }
    lines.push("");
  }

  lines.push("## Edge Evidence", "");
  for (const edge of graph.serviceEdges) {
    lines.push(`### ${edge.sourceServiceId} -> ${edge.targetServiceId}`);
    for (const call of edge.calls) {
      lines.push(`- ${call.httpMethod} ${call.path}`);
      if (call.sourceClassName) {
        lines.push(`- Client: ${call.sourceClassName}.${call.sourceMethodName}`);
      }
      if (call.provider) {
        lines.push(`- Provider: ${call.provider.targetClassName}.${call.provider.targetMethodName}`);
      }
      if (call.callSites && call.callSites.length > 0) {
        lines.push(`- Call sites: ${call.callSites.map((site) => `${site.className}.${site.methodName}`).join(", ")}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function safeMermaidId(value) {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}
