/**
 * @file nodejs.mjs
 * Language strategy for Node.js workspaces.
 *
 * Extracts service identity, dependencies, HTTP endpoints, and HTTP clients
 * from Node.js projects using package.json, JS/TS source scanning, and .env files.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  IGNORED_DIR_NAMES,
  pathExists,
  listFiles,
  deriveServiceAliases,
  normalizePath,
  dedupeBy,
  readQueueConfig,
  mergeQueueBindings,
} from "./base.mjs";

export const id = "nodejs";

export const indicatorFiles = ["package.json"];

// HTTP client libraries that signal a cross-service dependency
const HTTP_CLIENT_IMPORTS = new Set([
  "axios",
  "node-fetch",
  "got",
  "undici",
  "superagent",
  "cross-fetch",
  "ky",
  "bent",
  "needle",
]);

// Source file extensions to scan
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);

// ---------------------------------------------------------------------------
// LanguageStrategy interface
// ---------------------------------------------------------------------------

/**
 * Find all Node.js package roots within a workspace.
 * Supports both single-package and monorepo (multiple package.json) layouts.
 *
 * @param {string} rootDir
 * @returns {Promise<string[]>}
 */
export async function discoverServiceRoots(rootDir) {
  const roots = [];

  // Check root itself
  if (await pathExists(path.join(rootDir, "package.json"))) {
    // Check if root is a monorepo workspace (has workspaces field or packages/ dir)
    const rootPkg = await readPackageJson(path.join(rootDir, "package.json"));
    if (rootPkg?.workspaces) {
      // Monorepo root — find sub-packages instead
      const subRoots = await findSubPackages(rootDir);
      if (subRoots.length > 0) {
        roots.push(...subRoots);
        roots.sort((a, b) => a.localeCompare(b));
        return roots;
      }
    }
    roots.push(rootDir);
    roots.sort((a, b) => a.localeCompare(b));
    return roots;
  }

  // No root package.json — scan one level deep (monorepo without workspaces field)
  const subRoots = await findSubPackages(rootDir);
  roots.push(...subRoots);
  roots.sort((a, b) => a.localeCompare(b));
  return roots;
}

/**
 * Extract full service metadata for one Node.js service.
 *
 * @param {string} serviceRoot
 * @param {string} workspaceRoot
 * @returns {Promise<Object>}
 */
export async function analyzeService(serviceRoot, workspaceRoot) {
  const pkgPath = path.join(serviceRoot, "package.json");
  const pkg = (await readPackageJson(pkgPath)) || {};

  const serviceId = pkg.name
    ? pkg.name.replace(/^@[^/]+\//, "").replace(/[^a-z0-9-]/gi, "-")
    : path.basename(serviceRoot);

  const aliases = deriveServiceAliases([serviceId, pkg.name]);
  const properties = await loadEnvProperties(serviceRoot);
  const queueBindings = await readQueueConfig(serviceRoot);
  if (pkg.version) {
    properties["npm.version"] = pkg.version;
  }

  // Collect runtime dependencies (not devDependencies — mirrors classpath concept)
  const deps = {
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
  };

  // Scan source files
  const sourceFiles = await listFiles(
    serviceRoot,
    (entry) => entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)),
  );

  const endpoints = [];
  const clients = [];
  const classes = [];
  const methods = [];
  const fields = [];

  let fileCount = 0;
  for (const filePath of sourceFiles) {
    fileCount += 1;
    let text;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const relPath = path.relative(serviceRoot, filePath);
    extractEndpoints(text, filePath, relPath, serviceId, endpoints);
    extractClients(text, filePath, relPath, serviceId, deps, clients);
  }

  const detectedQueueBindings = await extractNodeQueueBindings(sourceFiles);
  const mergedQueueBindings = mergeQueueBindings(detectedQueueBindings, queueBindings);

  return {
    id: serviceId,
    name: pkg.name || serviceId,
    rootDir: serviceRoot,
    relativeRootDir: path.relative(workspaceRoot, serviceRoot),
    aliases,
    properties,
    classes,
    fields,
    methods,
    endpoints: dedupeBy(endpoints, (ep) => `${ep.httpMethod}:${ep.fullPath}:${ep.filePath}:${ep.line}`),
    clients: dedupeBy(clients, (c) => `${c.clientName}:${c.filePath}:${c.line}`),
    methodInteractions: [],
    queueBindings: mergedQueueBindings,
    _filesScanned: fileCount,
  };
}

// ---------------------------------------------------------------------------
// Queue binding auto-detection (Node.js)
// ---------------------------------------------------------------------------

const QUEUE_LIBS_RE = /kafkajs|kafka-node|node-rdkafka|amqplib|amqp\b|bullmq|\bbull\b/i;

/**
 * Auto-detect queue publisher/subscriber bindings from Node.js source files.
 *
 * Subscriber patterns:
 *   KafkaJS:  consumer.subscribe({ topic: 'name' } | { topics: ['t1','t2'] })
 *   amqplib:  channel.consume('queue-name', handler)
 *   Bull/BullMQ: new Worker('queue-name', processor)
 *
 * Publisher patterns:
 *   KafkaJS:  producer.send({ topic: 'name', messages: [...] })
 *   amqplib:  channel.sendToQueue('queue-name', buffer)
 *             channel.publish('exchange', 'routingKey', buffer)
 *   Bull/BullMQ: new Queue('queue-name')  (job enqueuer side)
 */
async function extractNodeQueueBindings(sourceFiles) {
  const bindings = [];

  for (const filePath of sourceFiles) {
    let text;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    if (!QUEUE_LIBS_RE.test(text)) continue;

    // ── KafkaJS: consumer.subscribe({ topic: 'name' }) ───────────────────────
    // Also: consumer.subscribe({ topics: ['t1', 't2'] })
    for (const m of text.matchAll(/\.subscribe\s*\(\s*\{[^}]*\btopics?\s*:\s*(?:(['"`])([^'"`]+)\1|\[([^\]]+)\])/g)) {
      if (m[2]) {
        bindings.push({ channel: m[2], role: "subscriber" });
      } else if (m[3]) {
        for (const t of extractJsStringList(m[3])) {
          bindings.push({ channel: t, role: "subscriber" });
        }
      }
    }

    // ── KafkaJS: producer.send({ topic: 'name', messages: [...] }) ───────────
    for (const m of text.matchAll(/\.send\s*\(\s*\{[^}]*\btopic\s*:\s*(['"`])([^'"`]+)\1/g)) {
      bindings.push({ channel: m[2], role: "publisher" });
    }

    // ── amqplib: channel.consume('queue-name', handler) ──────────────────────
    for (const m of text.matchAll(/\.consume\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
      bindings.push({ channel: m[1], role: "subscriber" });
    }

    // ── amqplib: channel.sendToQueue('queue-name', buffer) ───────────────────
    for (const m of text.matchAll(/\.sendToQueue\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
      bindings.push({ channel: m[1], role: "publisher" });
    }

    // ── amqplib: channel.publish('exchange', 'routingKey', buffer) ───────────
    // Only emit if the file actually imports amqplib to avoid false positives.
    if (/amqplib|amqp\b/.test(text)) {
      for (const m of text.matchAll(/\.publish\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]([^'"`]+)['"`]/g)) {
        bindings.push({ channel: m[1], role: "publisher" });
      }
    }

    // ── Bull/BullMQ: new Queue('name') → publisher side (job producer) ───────
    for (const m of text.matchAll(/\bnew\s+Queue\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
      bindings.push({ channel: m[1], role: "publisher" });
    }

    // ── Bull/BullMQ: new Worker('name', ...) → subscriber (job processor) ────
    for (const m of text.matchAll(/\bnew\s+Worker\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
      bindings.push({ channel: m[1], role: "subscriber" });
    }
  }

  return bindings;
}

function extractJsStringList(text) {
  const results = [];
  for (const m of text.matchAll(/['"`]([^'"`]+)['"`]/g)) {
    results.push(m[1]);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Endpoint extraction
// ---------------------------------------------------------------------------

// Patterns: Express app.get/post/..., router.get/post/..., Fastify, Koa, Hono
const ROUTE_PATTERNS = [
  // Express / Koa router: app.get('/path', ...) or router.post('/path')
  {
    re: /(?:app|router|server)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"` \n)]+)\2/gi,
    methodGroup: 1,
    pathGroup: 3,
  },
  // Fastify: fastify.get('/path')
  {
    re: /(?:fastify|server|app)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"` \n)]+)\2/gi,
    methodGroup: 1,
    pathGroup: 3,
  },
  // Hono: app.get('/path') — same as above, covered
  // Express route chaining: .route('/path').get(...)
  {
    re: /\.route\s*\(\s*(['"`])([^'"` \n)]+)\1\s*\)\s*\.\s*(get|post|put|patch|delete|head|options)/gi,
    methodGroup: 3,
    pathGroup: 2,
  },
];

function extractEndpoints(text, filePath, relPath, serviceId, endpoints) {
  const lines = text.split(/\r?\n/);

  for (const pattern of ROUTE_PATTERNS) {
    const re = new RegExp(pattern.re.source, "gi");
    for (const match of text.matchAll(re)) {
      const httpMethod = match[pattern.methodGroup].toUpperCase();
      const routePath = match[pattern.pathGroup];
      const lineNumber = getLineNumber(text, match.index);
      endpoints.push({
        id: `Endpoint:${filePath}:${httpMethod}:${routePath}:${lineNumber}`,
        httpMethod,
        path: routePath,
        fullPath: normalizePath(routePath),
        className: null,
        methodName: null,
        filePath,
        line: lineNumber,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP client extraction
// ---------------------------------------------------------------------------

function extractClients(text, filePath, relPath, serviceId, deps, clients) {
  const lines = text.split(/\r?\n/);

  // Detect which HTTP client libraries are imported in this file
  const importedClients = new Set();
  const importedAliases = new Map(); // alias → library name

  // ESM: import axios from 'axios'; import { get } from 'got'; import fetch from 'node-fetch'
  for (const match of text.matchAll(
    /import\s+(?:(\w+)|\*\s+as\s+(\w+)|(?:\{[^}]*\}))\s+from\s+['"]([^'"]+)['"]/g,
  )) {
    const lib = resolvePackageName(match[3]);
    if (HTTP_CLIENT_IMPORTS.has(lib)) {
      importedClients.add(lib);
      const alias = match[1] || match[2];
      if (alias) {
        importedAliases.set(alias, lib);
      }
    }
  }

  // CJS: const axios = require('axios')
  for (const match of text.matchAll(
    /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  )) {
    const lib = resolvePackageName(match[2]);
    if (HTTP_CLIENT_IMPORTS.has(lib)) {
      importedClients.add(lib);
      importedAliases.set(match[1], lib);
    }
  }

  if (importedClients.size === 0) {
    return;
  }

  // For each imported HTTP client, scan for calls and extract URL hints
  for (const [alias] of importedAliases) {
    // axios.get('http://service-name/api/...')  or  axios({ url: '...' })
    const callPattern = new RegExp(
      `${escapeRegex(alias)}\\s*\\.\\s*(get|post|put|patch|delete|head|options|request)\\s*\\(\\s*(['"\`])([^'"\`\\n)]+)\\2`,
      "gi",
    );
    for (const match of text.matchAll(callPattern)) {
      const httpMethod = match[1].toUpperCase();
      const url = match[3];
      const lineNumber = getLineNumber(text, match.index);
      clients.push({
        id: `Client:${filePath}:${alias}:${lineNumber}`,
        clientName: alias,
        baseUrl: url,
        fullPath: normalizePath(url),
        httpMethod,
        path: normalizePath(url),
        filePath,
        line: lineNumber,
        callSites: [],
      });
    }

    // fetch('url') or node-fetch style
    const fetchPattern = new RegExp(
      `(?:^|[^.\\w])(?:fetch|${escapeRegex(alias)})\\s*\\(\\s*(['"\`])([^'"\`\\n)]+)\\1`,
      "gm",
    );
    for (const match of text.matchAll(fetchPattern)) {
      const url = match[2];
      const lineNumber = getLineNumber(text, match.index);
      clients.push({
        id: `Client:${filePath}:fetch:${lineNumber}`,
        clientName: alias,
        baseUrl: url,
        fullPath: normalizePath(url),
        httpMethod: "GET",
        path: normalizePath(url),
        filePath,
        line: lineNumber,
        callSites: [],
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findSubPackages(rootDir) {
  const roots = [];
  let topDirents;
  try {
    topDirents = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return roots;
  }
  for (const dirent of topDirents) {
    if (!dirent.isDirectory() || IGNORED_DIR_NAMES.has(dirent.name)) {
      continue;
    }
    const pkgPath = path.join(rootDir, dirent.name, "package.json");
    if (await pathExists(pkgPath)) {
      roots.push(path.join(rootDir, dirent.name));
    }
  }
  return roots;
}

async function readPackageJson(pkgPath) {
  try {
    const text = await fs.readFile(pkgPath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function loadEnvProperties(serviceRoot) {
  const props = {};
  const envPath = path.join(serviceRoot, ".env");
  if (!(await pathExists(envPath))) {
    return props;
  }
  try {
    const text = await fs.readFile(envPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const idx = trimmed.indexOf("=");
      if (idx === -1) {
        continue;
      }
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
      props[key] = value;
    }
  } catch {
    // best-effort
  }
  return props;
}

function getLineNumber(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
    }
  }
  return line;
}

function resolvePackageName(importPath) {
  // Scoped: @scope/pkg → keep full; otherwise take first segment
  if (importPath.startsWith("@")) {
    return importPath.split("/").slice(0, 2).join("/");
  }
  return importPath.split("/")[0];
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
