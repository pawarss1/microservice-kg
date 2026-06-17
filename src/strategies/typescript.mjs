/**
 * @file typescript.mjs
 * Language strategy for TypeScript workspaces.
 *
 * Supports NestJS (decorator-based), Express, and Fastify route detection.
 * Detects kafkajs, @nestjs/microservices, and bullmq queue bindings.
 * Parses package.json for service identity and dependencies.
 * Zero external dependencies — pure Node.js string parsing.
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
  extractStringList,
} from "./base.mjs";

export const id = "typescript";

export const indicatorFiles = ["tsconfig.json", "package.json"];

// ---------------------------------------------------------------------------
// LanguageStrategy interface
// ---------------------------------------------------------------------------

/**
 * Find all TypeScript service roots within a workspace.
 *
 * @param {string} rootDir
 * @returns {Promise<string[]>}
 */
export async function discoverServiceRoots(rootDir) {
  const roots = [];

  // Check root itself
  if (await hasTypeScriptManifest(rootDir)) {
    roots.push(rootDir);
    return roots;
  }

  // Scan one level deep for sub-services
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
    const subDir = path.join(rootDir, dirent.name);
    if (await hasTypeScriptManifest(subDir)) {
      roots.push(subDir);
    }
  }

  roots.sort((a, b) => a.localeCompare(b));
  return roots;
}

/**
 * Extract full service metadata for one TypeScript service.
 *
 * @param {string} serviceRoot
 * @param {string} workspaceRoot
 * @returns {Promise<Object>}
 */
export async function analyzeService(serviceRoot, workspaceRoot) {
  const pkg = await loadPackageJson(serviceRoot);
  const serviceId = pkg.name || path.basename(serviceRoot);

  const subDirNames = await collectTopSubdirNames(serviceRoot);
  const aliases = deriveServiceAliases([serviceId, pkg.name, ...subDirNames]);

  const properties = await loadEnvProperties(serviceRoot);

  // Scan TypeScript source files (.ts only — not .d.ts)
  const sourceFiles = await listFiles(
    serviceRoot,
    (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"),
  );

  const endpoints = [];
  const clients = [];
  const classes = [];

  let fileCount = 0;
  for (const filePath of sourceFiles) {
    fileCount += 1;
    let text;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    extractEndpoints(text, filePath, endpoints);
    extractClients(text, filePath, clients);
    extractClasses(text, filePath, classes);
  }

  // Build constants map for topic name resolution, then auto-detect queue bindings
  const constantsMap = await buildConstantsMap(sourceFiles);
  const detectedQueueBindings = await extractQueueBindings(sourceFiles, constantsMap);
  const queueBindings = mergeQueueBindings(
    detectedQueueBindings,
    await readQueueConfig(serviceRoot),
  );

  return {
    id: serviceId,
    name: pkg.name || serviceId,
    rootDir: serviceRoot,
    relativeRootDir: path.relative(workspaceRoot, serviceRoot),
    aliases,
    properties,
    dependencies: pkg.dependencies || [],
    classes,
    fields: [],
    methods: [],
    endpoints: dedupeBy(endpoints, (ep) => `${ep.httpMethod}:${ep.fullPath}:${ep.filePath}:${ep.line}`),
    clients: dedupeBy(clients, (c) => `${c.clientName}:${c.urlExpression || c.baseUrl || ""}:${c.filePath}:${c.line}`),
    methodInteractions: [],
    queueBindings,
    _filesScanned: fileCount,
  };
}

// ---------------------------------------------------------------------------
// Detection helper
// ---------------------------------------------------------------------------

async function hasTypeScriptManifest(dir) {
  return pathExists(path.join(dir, "tsconfig.json"));
}

// ---------------------------------------------------------------------------
// Package.json parsing
// ---------------------------------------------------------------------------

async function loadPackageJson(serviceRoot) {
  const pkgPath = path.join(serviceRoot, "package.json");
  if (!(await pathExists(pkgPath))) {
    return { name: null, dependencies: [] };
  }
  try {
    const text = await fs.readFile(pkgPath, "utf8");
    const parsed = JSON.parse(text);
    const deps = [
      ...Object.keys(parsed.dependencies || {}),
      ...Object.keys(parsed.devDependencies || {}),
    ];
    return { name: parsed.name || null, dependencies: deps };
  } catch {
    return { name: null, dependencies: [] };
  }
}

// ---------------------------------------------------------------------------
// Top subdirectory names (for alias derivation)
// ---------------------------------------------------------------------------

async function collectTopSubdirNames(serviceRoot) {
  const GENERIC = new Set(["src", "lib", "bin", "docs", "tests", "test", "dist", "build", "scripts", "config"]);
  let dirents;
  try {
    dirents = await fs.readdir(serviceRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return dirents
    .filter((d) => d.isDirectory() && !IGNORED_DIR_NAMES.has(d.name) && !GENERIC.has(d.name) && d.name.length >= 4)
    .map((d) => d.name);
}

// ---------------------------------------------------------------------------
// Constants map (UPPER_CASE string constants → values for topic resolution)
// ---------------------------------------------------------------------------

async function buildConstantsMap(sourceFiles) {
  const constants = new Map();
  const PATTERN = /^(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\s*=\s*['"`]([^'"`]+)['"`]/gm;
  for (const filePath of sourceFiles) {
    let text;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(PATTERN)) {
      if (!constants.has(m[1])) {
        constants.set(m[1], m[2]);
      }
    }
  }
  return constants;
}

function resolveTopicArg(arg, constantsMap) {
  const trimmed = arg.trim();
  const litMatch = trimmed.match(/^['"`]([^'"`]+)['"`]$/);
  if (litMatch) return litMatch[1];
  const constMatch = trimmed.match(/(?:\w+\.)?([A-Z][A-Z0-9_]{2,})$/);
  if (constMatch) return constantsMap.get(constMatch[1]) || null;
  return null;
}

// ---------------------------------------------------------------------------
// Endpoint extraction
// ---------------------------------------------------------------------------

/**
 * Extract HTTP route definitions from TypeScript source.
 * Supports NestJS decorators (@Controller, @Get, @Post, …) and
 * Express/Fastify method chains (app.get('/path', …)).
 */
function extractEndpoints(text, filePath, endpoints) {
  // ── NestJS: @Controller('prefix') + @Get/@Post/… method decorators ─────────
  // Pre-scan for controller prefix in this file (one controller per file is typical)
  let controllerPrefix = "";
  const controllerMatch = text.match(/@Controller\s*\(\s*(['"`])([^'"`]*)\1/);
  if (controllerMatch) {
    controllerPrefix = controllerMatch[2].startsWith("/") ? controllerMatch[2] : `/${controllerMatch[2]}`;
  }

  const nestMethodRe = /@(Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*(?:(['"`])([^'"`]*)\2)?\s*\)/gi;
  for (const m of text.matchAll(nestMethodRe)) {
    const httpMethod = m[1].toUpperCase();
    const routeSegment = m[3] !== undefined ? m[3] : "";
    const normalizedSegment = routeSegment.startsWith("/") ? routeSegment : (routeSegment ? `/${routeSegment}` : "");
    const fullRoute = controllerPrefix + normalizedSegment || "/";
    const lineNumber = getLineNumber(text, m.index);
    const handlerName = findHandlerAfterDecorator(text, m.index + m[0].length);
    const className = findEnclosingClass(text, m.index);
    endpoints.push(makeEndpoint(httpMethod, fullRoute, filePath, lineNumber, handlerName, className));
  }

  // ── Express / Fastify: (app|router|server|fastify|\w+).(get|post|…)('/path', …) ──
  const expressRe = /\b(\w+)\.(get|post|put|patch|delete|options|head)\s*\(\s*(['"`])([^'"`\n)]+)\3/gi;
  for (const m of text.matchAll(expressRe)) {
    const varName = m[1].toLowerCase();
    // Skip NestJS-style chained decorators and non-router variable names
    // Accept: app, router, server, fastify, and any variable that plausibly holds a router
    if (["this", "res", "req", "response", "request", "client", "axios", "httpService"].includes(varName)) {
      continue;
    }
    const httpMethod = m[2].toUpperCase();
    const routePath = m[4];
    const lineNumber = getLineNumber(text, m.index);
    const handlerName = null;
    const className = findEnclosingClass(text, m.index);
    endpoints.push(makeEndpoint(httpMethod, routePath, filePath, lineNumber, handlerName, className));
  }
}

function makeEndpoint(httpMethod, routePath, filePath, lineNumber, methodName = null, className = null) {
  return {
    id: `Endpoint:${filePath}:${httpMethod}:${routePath}:${lineNumber}`,
    httpMethod: httpMethod.toUpperCase(),
    path: routePath,
    fullPath: normalizePath(routePath),
    className,
    methodName,
    filePath,
    line: lineNumber,
  };
}

// ---------------------------------------------------------------------------
// HTTP client extraction
// ---------------------------------------------------------------------------

const HTTP_CLIENT_IMPORTS = new Set([
  "axios",
  "node-fetch",
  "got",
  "undici",
  "superagent",
  "cross-fetch",
  "ky",
  "needle",
  "bent",
]);

function extractClients(text, filePath, clients) {
  // Detect imported HTTP client aliases
  const importedAliases = new Map(); // alias → lib name

  // import axios from 'axios'  /  import got from 'got'
  for (const m of text.matchAll(/^import\s+(\w+)\s+from\s+['"`]([\w@/-]+)['"`]/gm)) {
    const alias = m[1];
    const lib = m[2].split("/").pop();
    if (HTTP_CLIENT_IMPORTS.has(lib) || HTTP_CLIENT_IMPORTS.has(m[2])) {
      importedAliases.set(alias, lib);
    }
  }

  // import { HttpService } from '@nestjs/axios'  / { get } from 'axios'
  for (const m of text.matchAll(/^import\s+\{([^}]+)\}\s+from\s+['"`]([\w@/-]+)['"`]/gm)) {
    const lib = m[2];
    const isHttpLib = HTTP_CLIENT_IMPORTS.has(lib.split("/").pop()) || lib.includes("nestjs");
    if (!isHttpLib) continue;
    for (const part of m[1].split(",")) {
      const nameMatch = part.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
      if (nameMatch) {
        importedAliases.set(nameMatch[2] || nameMatch[1], lib);
      }
    }
  }

  if (importedAliases.size === 0) {
    // Still scan for URL path literals (indirect clients)
    scanUrlPathLiterals(text, filePath, clients);
    return;
  }

  for (const [alias] of importedAliases) {
    // ── Pattern A: literal string URL ──────────────────────────────────────
    const callPattern = new RegExp(
      `${escapeRegex(alias)}\\s*\\.\\s*(get|post|put|patch|delete|head|options|request)\\s*\\(\\s*(['"\`])([^'"\`\\n)]+)\\2`,
      "gi",
    );
    for (const m of text.matchAll(callPattern)) {
      const httpMethod = m[1].toUpperCase();
      const url = m[3];
      const lineNumber = getLineNumber(text, m.index);
      const methodName = findEnclosingFunction(text, m.index);
      const className = findEnclosingClass(text, m.index);
      clients.push({
        id: `Client:${filePath}:${alias}:${lineNumber}`,
        clientName: alias,
        methodName,
        className,
        baseUrl: url,
        fullPath: normalizePath(url),
        httpMethod,
        path: normalizePath(url),
        filePath,
        line: lineNumber,
        callSites: [{ filePath, line: lineNumber }],
      });
    }

    // ── Pattern B: this.httpService.get/post/… (NestJS HttpService) ────────
    const nestHttpRe = new RegExp(
      `this\\.${escapeRegex(alias)}\\s*\\.\\s*(get|post|put|patch|delete)\\s*\\(\\s*(['"\`])([^'"\`\\n)]+)\\2`,
      "gi",
    );
    for (const m of text.matchAll(nestHttpRe)) {
      const httpMethod = m[1].toUpperCase();
      const url = m[3];
      const lineNumber = getLineNumber(text, m.index);
      clients.push({
        id: `Client:${filePath}:this.${alias}:${lineNumber}`,
        clientName: alias,
        methodName: findEnclosingFunction(text, m.index),
        className: findEnclosingClass(text, m.index),
        baseUrl: url,
        fullPath: normalizePath(url),
        httpMethod,
        path: normalizePath(url),
        filePath,
        line: lineNumber,
        callSites: [{ filePath, line: lineNumber }],
      });
    }
  }

  scanUrlPathLiterals(text, filePath, clients);
}

function scanUrlPathLiterals(text, filePath, clients) {
  const urlPathLiteral = /['"`](\/[a-z][a-z0-9_/-]{3,})['"`]/gi;
  for (const m of text.matchAll(urlPathLiteral)) {
    const rawPath = m[1];
    if (!rawPath.slice(1).includes("/")) continue;
    const lineNumber = getLineNumber(text, m.index);
    clients.push({
      id: `Client:${filePath}:path-lit:${lineNumber}`,
      clientName: "_path_literal",
      methodName: findEnclosingFunction(text, m.index),
      className: findEnclosingClass(text, m.index),
      urlExpression: null,
      baseUrl: null,
      fullPath: normalizePath(rawPath),
      httpMethod: "GET",
      path: normalizePath(rawPath),
      filePath,
      line: lineNumber,
      callSites: [{ filePath, line: lineNumber }],
    });
  }
}

// ---------------------------------------------------------------------------
// Class extraction
// ---------------------------------------------------------------------------

function extractClasses(text, filePath, classes) {
  const classRe = /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/gm;
  for (const m of text.matchAll(classRe)) {
    const className = m[1];
    const bases = [m[2], ...(m[3] ? m[3].split(",").map((s) => s.trim()) : [])].filter(Boolean);
    classes.push({
      id: `Class:${filePath}:${className}`,
      name: className,
      bases,
      filePath,
      line: getLineNumber(text, m.index),
    });
  }
}

// ---------------------------------------------------------------------------
// Queue binding extraction
// ---------------------------------------------------------------------------

async function extractQueueBindings(sourceFiles, constantsMap) {
  const bindings = [];

  for (const filePath of sourceFiles) {
    let text;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    // ── kafkajs: producer.send({ topic: 'name', … }) ─────────────────────
    for (const m of text.matchAll(/\bproducer\s*\.\s*send\s*\(\s*\{[^}]*\btopic\s*:\s*([^,}\n]+)/g)) {
      const topic = resolveTopicArg(m[1], constantsMap);
      if (topic) bindings.push({ channel: topic, role: "publisher" });
    }

    // ── kafkajs: consumer.subscribe({ topic: 'name' }) ────────────────────
    for (const m of text.matchAll(/\bconsumer\s*\.\s*subscribe\s*\(\s*\{[^}]*\btopics?\s*:\s*([^,}\n]+)/g)) {
      const raw = m[1].trim();
      // Array form: ['t1', 't2']
      if (raw.startsWith("[")) {
        for (const t of extractStringList(raw)) {
          bindings.push({ channel: t, role: "subscriber" });
        }
        // Resolve UPPER_CASE constants inside the array
        for (const constM of raw.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
          const resolved = constantsMap.get(constM[1]);
          if (resolved) bindings.push({ channel: resolved, role: "subscriber" });
        }
      } else {
        const topic = resolveTopicArg(raw, constantsMap);
        if (topic) bindings.push({ channel: topic, role: "subscriber" });
      }
    }

    // ── @nestjs/microservices: @MessagePattern('event') → subscriber ──────
    for (const m of text.matchAll(/@(?:MessagePattern|EventPattern)\s*\(\s*(['"`])([^'"`]+)\1/g)) {
      bindings.push({ channel: m[2], role: "subscriber" });
    }

    // ── @nestjs/microservices: this.client.emit/send('event') → publisher ─
    for (const m of text.matchAll(/this\.\w+\s*\.\s*(?:emit|send)\s*\(\s*(['"`])([^'"`]+)\1/g)) {
      bindings.push({ channel: m[2], role: "publisher" });
    }

    // ── bullmq: new Queue('name') → publisher ─────────────────────────────
    for (const m of text.matchAll(/new\s+Queue\s*\(\s*(['"`])([^'"`]+)\1/g)) {
      bindings.push({ channel: m[2], role: "publisher" });
    }

    // ── bullmq: new Worker('name', …) → subscriber ────────────────────────
    for (const m of text.matchAll(/new\s+Worker\s*\(\s*(['"`])([^'"`]+)\1/g)) {
      bindings.push({ channel: m[2], role: "subscriber" });
    }
  }

  return bindings;
}

// ---------------------------------------------------------------------------
// Enclosing scope helpers
// ---------------------------------------------------------------------------

function findEnclosingFunction(text, callIndex) {
  const lines = text.slice(0, callIndex).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/(?:async\s+)?(?:function\s+(\w+)|\b(\w+)\s*(?:=\s*async\s*)?\([^)]*\)\s*(?::\s*\w+\s*)?\s*(?:=>|\{))/);
    if (m) return m[1] || m[2] || null;
  }
  return null;
}

function findEnclosingClass(text, callIndex) {
  const lines = text.slice(0, callIndex).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
    if (m) return m[1];
  }
  return null;
}

function findHandlerAfterDecorator(text, afterIndex) {
  const after = text.slice(afterIndex);
  const lines = after.split("\n");
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const m = lines[i].match(/(?:async\s+)?(\w+)\s*\(/);
    if (m && !["if", "for", "while", "switch", "catch"].includes(m[1])) {
      return m[1];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadEnvProperties(serviceRoot) {
  const props = {};
  const envPath = path.join(serviceRoot, ".env");
  if (!(await pathExists(envPath))) return props;
  try {
    const text = await fs.readFile(envPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
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
    if (text[i] === "\n") line++;
  }
  return line;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
