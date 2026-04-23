/**
 * @file python.mjs
 * Language strategy for Python workspaces.
 *
 * Supports Flask, FastAPI, and Django route detection.
 * Parses pyproject.toml (preferred) and requirements.txt for dependency info.
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

export const id = "python";

export const indicatorFiles = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"];

// ---------------------------------------------------------------------------
// LanguageStrategy interface
// ---------------------------------------------------------------------------

/**
 * Find all Python service roots within a workspace.
 *
 * @param {string} rootDir
 * @returns {Promise<string[]>}
 */
export async function discoverServiceRoots(rootDir) {
  const roots = [];

  // Check root itself
  if (await hasPythonManifest(rootDir)) {
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
    if (await hasPythonManifest(subDir) || await hasQueueServiceIndicator(subDir)) {
      roots.push(subDir);
    }
  }

  roots.sort((a, b) => a.localeCompare(b));
  return roots;
}

/**
 * Extract full service metadata for one Python service.
 *
 * @param {string} serviceRoot
 * @param {string} workspaceRoot
 * @returns {Promise<Object>}
 */
export async function analyzeService(serviceRoot, workspaceRoot) {
  // Load manifest (precedence: pyproject.toml > setup.cfg > setup.py > requirements.txt)
  const manifest = await loadManifest(serviceRoot);
  const serviceId = manifest.name || path.basename(serviceRoot);

  // Include top-level subdirectory names as potential service aliases (e.g. "api-utils" dir)
  const subDirNames = await collectTopSubdirNames(serviceRoot);
  const aliases = deriveServiceAliases([serviceId, manifest.name, ...subDirNames]);

  const properties = await loadEnvProperties(serviceRoot);
  if (manifest.version) {
    properties["python.version"] = manifest.version;
  }

  // Scan Python source files
  const sourceFiles = await listFiles(
    serviceRoot,
    (entry) => entry.isFile() && entry.name.endsWith(".py"),
  );

  // Pre-scan: collect FastAPI include_router prefixes and Django path() prefixes
  const routerPrefixes = await collectRouterPrefixes(sourceFiles);
  const djangoPrefixMap = await collectDjangoUrlPrefixes(sourceFiles, serviceRoot);

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

    // Determine Django URL prefix for this file (if any)
    const djangoModule = filePath
      .slice(serviceRoot.length + 1)
      .replace(/\\/g, "/")
      .replace(/\//g, ".")
      .replace(/\.py$/, "");
    const djangoPrefix = djangoPrefixMap.get(djangoModule) || "";

    extractEndpoints(text, filePath, endpoints, routerPrefixes, djangoPrefix);
    extractClients(text, filePath, clients);
    extractModels(text, filePath, classes);
  }

  // Build constants map across all source files for topic name resolution,
  // then auto-detect queue bindings, merging with any manual config.
  const constantsMap = await buildConstantsMap(sourceFiles);
  const detectedQueueBindings = await extractPythonQueueBindings(sourceFiles, constantsMap);
  const queueBindings = mergeQueueBindings(detectedQueueBindings, await readQueueConfig(serviceRoot));

  return {
    id: serviceId,
    name: manifest.name || serviceId,
    rootDir: serviceRoot,
    relativeRootDir: path.relative(workspaceRoot, serviceRoot),
    aliases,
    properties,
    dependencies: manifest.dependencies || [],
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
// Pre-scan helpers
// ---------------------------------------------------------------------------

/**
 * Collect top-level subdirectory names to use as extra service aliases.
 * Filters out generic names and ignored dirs.
 */
async function collectTopSubdirNames(serviceRoot) {
  const GENERIC = new Set(["src", "lib", "bin", "docs", "tests", "test", "migrations", "static", "templates", "scripts", "config", "infra", "docker"]);
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

/**
 * Scan source files for FastAPI `app.include_router(router_var, prefix="/path")` calls.
 * Returns a Map from router variable name → prefix string.
 */
async function collectRouterPrefixes(sourceFiles) {
  const prefixMap = new Map();
  for (const filePath of sourceFiles) {
    let text;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    // .include_router(router_var, prefix="/enrichments")  (prefix can appear anywhere in args)
    for (const m of text.matchAll(/\.include_router\s*\(\s*(\w+)\s*,(?:[^)]*?\s+)?prefix\s*=\s*['"]([^'"]+)['"]/g)) {
      prefixMap.set(m[1], m[2].replace(/\/$/, ""));
    }
  }
  return prefixMap;
}

/**
 * Scan urls.py files for Django `path('prefix/', include((router.urls, ...)))` patterns.
 * Returns a Map from Django module path (e.g. "bank_connect.urls") → URL prefix string.
 */
async function collectDjangoUrlPrefixes(sourceFiles, serviceRoot) {
  const prefixMap = new Map();
  for (const filePath of sourceFiles) {
    if (!filePath.endsWith("urls.py")) continue;
    let text;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    // Build import alias map: imported var alias → full dotted module.name
    const importAliases = new Map();
    for (const m of text.matchAll(/^from\s+([\w.]+)\s+import\s+(\w+)(?:\s+as\s+(\w+))?/gm)) {
      const module = m[1];
      const imported = m[2];
      const alias = m[3] || imported;
      // alias → "module.imported" so we can reconstruct the source module
      importAliases.set(alias, `${module}.${imported}`);
      if (!importAliases.has(imported)) {
        importAliases.set(imported, `${module}.${imported}`);
      }
    }

    // path('bank-connect/v1/', include((bank_connect_router.urls, ...)))
    // path('bank-connect/v1/', include('bank_connect.urls'))
    for (const m of text.matchAll(/path\s*\(\s*['"]([^'"]+)['"]\s*,\s*include\s*\(([^)]+)\)/g)) {
      const urlPrefix = m[1].replace(/\/$/, "");
      const includeArg = m[2].trim();

      // Tuple form: (routerVar.urls, ...) or [routerVar.urls, ...]
      const tupleMatch = includeArg.match(/[\(\[]\s*(\w+)\.urls/);
      if (tupleMatch) {
        const routerAlias = tupleMatch[1];
        const fullModule = importAliases.get(routerAlias);
        if (fullModule) {
          // "bank_connect.urls.router" → drop last segment → "bank_connect.urls"
          const moduleParts = fullModule.split(".");
          const moduleKey = moduleParts.slice(0, -1).join(".");
          prefixMap.set(moduleKey, urlPrefix);
        }
        continue;
      }

      // String form: 'bank_connect.urls'
      const strMatch = includeArg.match(/^['"]([^'"]+)['"]/);
      if (strMatch) {
        prefixMap.set(strMatch[1], urlPrefix);
      }
    }
  }
  return prefixMap;
}

// ---------------------------------------------------------------------------
// Queue service discovery helper
// ---------------------------------------------------------------------------

/**
 * Returns true if a directory contains Python files that import queue libraries
 * (Kafka, Celery, pika/RabbitMQ, etc.) even without a Python package manifest.
 * Checks only top-level .py files and only the first 3 KB of each file to
 * keep the cost low.
 */
async function hasQueueServiceIndicator(dir) {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  const QUEUE_RE = /\b(?:kafka|celery|kombu|pika|dramatiq|rq)\b/i;
  const pyFiles = dirents.filter((d) => d.isFile() && d.name.endsWith(".py"));
  for (const f of pyFiles.slice(0, 6)) {
    try {
      const text = await fs.readFile(path.join(dir, f.name), "utf8");
      if (QUEUE_RE.test(text.slice(0, 3000))) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Queue binding auto-detection
// ---------------------------------------------------------------------------

/**
 * Collect module-level UPPER_CASE string constants across all Python source
 * files in a service. Used to resolve topic names from constant references.
 *
 * e.g. EMAIL_DELIVERY_KAFKA_TOPIC = "email_deliveries"
 *      → Map { 'EMAIL_DELIVERY_KAFKA_TOPIC' → 'email_deliveries' }
 */
async function buildConstantsMap(sourceFiles) {
  const constants = new Map();
  const PATTERN = /^([A-Z][A-Z0-9_]{2,})\s*=\s*['"]([^'"]+)['"]/gm;
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

/**
 * Resolve a topic argument token to a concrete string.
 * Handles:
 *   "literal"            → literal
 *   'literal'            → literal
 *   SOME_CONST           → constantsMap lookup
 *   settings.SOME_CONST  → constantsMap lookup by the trailing name
 */
function resolveTopicArg(arg, constantsMap) {
  const trimmed = arg.trim();
  const litMatch = trimmed.match(/^['"`]([^'"`]+)['"`]$/);
  if (litMatch) return litMatch[1];
  const constMatch = trimmed.match(/(?:\w+\.)?([A-Z][A-Z0-9_]{2,})$/);
  if (constMatch) return constantsMap.get(constMatch[1]) || null;
  return null;
}

/**
 * Auto-detect queue publisher/subscriber bindings from Python source files.
 *
 * Covers:
 *  Kafka (kafka-python / confluent-kafka): KafkaConsumer, .subscribe(), .send(topic=), .produce()
 *  Celery: @task(queue=), .apply_async(queue=)
 *  pika / RabbitMQ: basic_consume(queue=), basic_publish(routing_key=)
 */
async function extractPythonQueueBindings(sourceFiles, constantsMap) {
  const bindings = [];

  for (const filePath of sourceFiles) {
    let text;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    // ── Kafka subscriber: KafkaConsumer('topic1', 'topic2', ...) ────────────
    // Also handles KafkaConsumer(topics=['t1', 't2'])
    // Topic names are positional args BEFORE the first keyword arg OR in topics=[].
    // Keyword arg values like auto_offset_reset='earliest', security_protocol="SSL"
    // must not be mistaken for topic names.
    for (const m of text.matchAll(/\bKafkaConsumer\s*\(/g)) {
      const start = m.index + m[0].length;
      const args = extractBalancedArgs(text, start);
      if (!args) continue;
      const topicsArg = args.match(/\btopics\s*=\s*\[([^\]]+)\]/);
      if (topicsArg) {
        for (const t of extractStringList(topicsArg[1])) {
          bindings.push({ channel: t, role: "subscriber" });
        }
      } else {
        // Only take positional string args that appear before the first keyword= arg.
        for (const t of extractLeadingPositionalStrings(args)) {
          bindings.push({ channel: t, role: "subscriber" });
        }
      }
    }

    // ── Kafka subscriber (confluent): consumer.subscribe(['topic', ...]) ─────
    for (const m of text.matchAll(/\.subscribe\s*\(\s*\[([^\]]+)\]/g)) {
      for (const t of extractStringList(m[1])) {
        bindings.push({ channel: t, role: "subscriber" });
      }
    }

    // ── Publisher: any .send(topic=X) or .send(topic=CONST) ──────────────────
    // Scan for `topic =` assignment pattern in the full text; verify the
    // surrounding 300-char window contains a .send( or .produce( call opener.
    for (const m of text.matchAll(/\btopic\s*=\s*(['"`][^'"`\n]*['"`]|(?:\w+\.)?[A-Z][A-Z0-9_]{2,})/g)) {
      const topic = resolveTopicArg(m[1], constantsMap);
      if (!topic) continue;
      const before = text.slice(Math.max(0, m.index - 300), m.index);
      if (/\.(send|produce)\s*\(/.test(before)) {
        bindings.push({ channel: topic, role: "publisher" });
      }
    }

    // ── Publisher: .produce('topic', ...) — confluent-kafka ──────────────────
    for (const m of text.matchAll(/\.produce\s*\(\s*(['"`])([^'"`]+)\1/g)) {
      bindings.push({ channel: m[2], role: "publisher" });
    }

    // ── Celery subscriber: @<app>.task(queue='name') ──────────────────────────
    for (const m of text.matchAll(/@\w+\.task\s*\([^)]*\bqueue\s*=\s*['"]([^'"]+)['"]/g)) {
      bindings.push({ channel: m[1], role: "subscriber" });
    }

    // ── Celery publisher: .apply_async(queue='name') ──────────────────────────
    for (const m of text.matchAll(/\.apply_async\s*\([^)]*\bqueue\s*=\s*['"]([^'"]+)['"]/g)) {
      bindings.push({ channel: m[1], role: "publisher" });
    }

    // ── pika (RabbitMQ) subscriber: .basic_consume(queue='name', ...) ─────────
    for (const m of text.matchAll(/\.basic_consume\s*\([^)]*\bqueue\s*=\s*['"]([^'"]+)['"]/g)) {
      bindings.push({ channel: m[1], role: "subscriber" });
    }

    // ── pika (RabbitMQ) publisher: .basic_publish(..., routing_key='name') ────
    for (const m of text.matchAll(/\.basic_publish\s*\([^)]*\brouting_key\s*=\s*['"]([^'"]+)['"]/g)) {
      bindings.push({ channel: m[1], role: "publisher" });
    }
  }

  return bindings;
}

/**
 * Extract the content between the opening paren at `start` and its matching
 * closing paren, handling nested parens. Returns null if unbalanced.
 * Capped at 2 000 chars to avoid scanning entire files.
 */
function extractBalancedArgs(text, start) {
  const CAP = 2000;
  let depth = 1;
  for (let i = start; i < Math.min(text.length, start + CAP); i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(start, i);
    }
  }
  return null;
}

/**
 * Extract only the positional string arguments that appear before the first
 * `keyword=value` argument in a Python call arg string.
 *
 * e.g. "'t1', 't2', group_id='g'"  → ['t1', 't2']
 *      "client_id=x, auto_offset_reset='earliest'" → []
 */
function extractLeadingPositionalStrings(args) {
  const firstKeyword = args.search(/\b[a-z_]\w*\s*=/);
  const positionalPart = firstKeyword >= 0 ? args.slice(0, firstKeyword) : args;
  return extractStringList(positionalPart);
}

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

async function hasPythonManifest(dir) {
  for (const filename of ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"]) {
    if (await pathExists(path.join(dir, filename))) {
      return true;
    }
  }
  return false;
}

/**
 * Load service identity and dependencies from the highest-priority manifest.
 * Precedence: pyproject.toml > setup.cfg > setup.py > requirements.txt
 */
async function loadManifest(serviceRoot) {
  // Try pyproject.toml first
  const pyprojectPath = path.join(serviceRoot, "pyproject.toml");
  if (await pathExists(pyprojectPath)) {
    try {
      const text = await fs.readFile(pyprojectPath, "utf8");
      return parsePyprojectToml(text);
    } catch {
      // fall through
    }
  }

  // Try setup.cfg
  const setupCfgPath = path.join(serviceRoot, "setup.cfg");
  if (await pathExists(setupCfgPath)) {
    try {
      const text = await fs.readFile(setupCfgPath, "utf8");
      return parseSetupCfg(text);
    } catch {
      // fall through
    }
  }

  // Try requirements.txt (identity comes from directory name)
  const requirementsPath = path.join(serviceRoot, "requirements.txt");
  if (await pathExists(requirementsPath)) {
    try {
      const text = await fs.readFile(requirementsPath, "utf8");
      return { name: null, version: null, dependencies: parseRequirementsTxt(text) };
    } catch {
      // fall through
    }
  }

  return { name: null, version: null, dependencies: [] };
}

/**
 * Hand-parse the [project] table from pyproject.toml.
 * Only extracts: name, version, dependencies (list).
 * Full TOML spec is not needed — see research.md Decision 4.
 */
function parsePyprojectToml(text) {
  const result = { name: null, version: null, dependencies: [] };
  const lines = text.split(/\r?\n/);
  let inProjectTable = false;
  let inDepsArray = false;
  let depsBuffer = "";

  for (const raw of lines) {
    const line = raw.trim();

    // Table header
    if (/^\[project\]/.test(line)) {
      inProjectTable = true;
      inDepsArray = false;
      continue;
    }
    if (/^\[/.test(line) && !/^\[project\./.test(line)) {
      if (inProjectTable) {
        inProjectTable = false;
      }
      inDepsArray = false;
      continue;
    }
    if (!inProjectTable) {
      continue;
    }

    // Collecting multi-line dependencies array
    if (inDepsArray) {
      if (line.includes("]")) {
        depsBuffer += line.slice(0, line.indexOf("]"));
        inDepsArray = false;
        result.dependencies = parseDepsArray(depsBuffer);
        depsBuffer = "";
      } else {
        depsBuffer += line + "\n";
      }
      continue;
    }

    // name = "..."
    const nameMatch = line.match(/^name\s*=\s*["']([^"']+)["']/);
    if (nameMatch) {
      result.name = nameMatch[1];
      continue;
    }

    // version = "..."
    const versionMatch = line.match(/^version\s*=\s*["']([^"']+)["']/);
    if (versionMatch) {
      result.version = versionMatch[1];
      continue;
    }

    // dependencies = [ ... ] (possibly multi-line)
    const depsMatch = line.match(/^dependencies\s*=\s*\[([^\]]*)\]?/);
    if (depsMatch) {
      const inner = depsMatch[1];
      if (line.includes("]")) {
        result.dependencies = parseDepsArray(inner);
      } else {
        inDepsArray = true;
        depsBuffer = inner + "\n";
      }
      continue;
    }
  }

  return result;
}

function parseDepsArray(inner) {
  return inner
    .split(/,|\n/)
    .map((s) => s.trim().replace(/^["']|["']$/g, "").replace(/[><=~!;].*$/, "").trim())
    .filter(Boolean);
}

function parseSetupCfg(text) {
  const result = { name: null, version: null, dependencies: [] };
  let inMetadata = false;
  let inOptions = false;
  let inInstallRequires = false;
  const deps = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "[metadata]") { inMetadata = true; inOptions = false; continue; }
    if (line === "[options]") { inOptions = true; inMetadata = false; continue; }
    if (/^\[/.test(line)) { inMetadata = false; inOptions = false; inInstallRequires = false; continue; }

    if (inMetadata) {
      const nameMatch = line.match(/^name\s*=\s*(.+)/);
      if (nameMatch) { result.name = nameMatch[1].trim(); continue; }
      const versionMatch = line.match(/^version\s*=\s*(.+)/);
      if (versionMatch) { result.version = versionMatch[1].trim(); continue; }
    }
    if (inOptions) {
      if (/^install_requires\s*=/.test(line)) { inInstallRequires = true; continue; }
      if (inInstallRequires) {
        if (/^\s+/.test(raw) && line) {
          deps.push(line.replace(/[><=~!;].*$/, "").trim());
        } else {
          inInstallRequires = false;
        }
      }
    }
  }
  result.dependencies = deps;
  return result;
}

function parseRequirementsTxt(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("-"))
    .map((l) => l.replace(/[><=~!;].*$/, "").replace(/#.*$/, "").trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Endpoint extraction
// ---------------------------------------------------------------------------

/**
 * @param {string} text
 * @param {string} filePath
 * @param {Array} endpoints
 * @param {Map<string,string>} routerPrefixes - FastAPI include_router prefixes
 * @param {string} djangoPrefix - Django path() include prefix for this file
 */
function extractEndpoints(text, filePath, endpoints, routerPrefixes = new Map(), djangoPrefix = "") {
  // Flask: @app.route('/path', methods=['GET', 'POST'])
  //        @bp.route('/path')
  const flaskRoute = /@(?:app|bp|blueprint|\w+)\.route\s*\(\s*(['"`])([^'"` \n)]+)\1(?:[^)]*methods\s*=\s*\[([^\]]*)\])?/g;
  for (const match of text.matchAll(flaskRoute)) {
    const routePath = match[2];
    const methodsList = match[3];
    const lineNumber = getLineNumber(text, match.index);
    if (methodsList) {
      const methods = methodsList.match(/['"]([A-Z]+)['"]/g)?.map((m) => m.replace(/['"]/g, "")) || ["GET"];
      for (const httpMethod of methods) {
        endpoints.push(makeEndpoint(httpMethod, routePath, filePath, lineNumber));
      }
    } else {
      endpoints.push(makeEndpoint("GET", routePath, filePath, lineNumber));
    }
  }

  // FastAPI / APIRouter decorators: @router.get('/path'), @app.post('/path')
  // Now also applies include_router prefix when the router variable has one registered.
  const fastapiRoute =
    /@(\w+)\.(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"` \n)]+)\3/gi;
  for (const match of text.matchAll(fastapiRoute)) {
    const routerVar = match[1];
    const httpMethod = match[2].toUpperCase();
    const routePath = match[4];
    const lineNumber = getLineNumber(text, match.index);
    // Apply include_router prefix if this router variable is registered with one
    const prefix = routerPrefixes.get(routerVar) || "";
    endpoints.push(makeEndpoint(httpMethod, prefix + routePath, filePath, lineNumber));
  }

  // Django urls.py: path('endpoint/', view), re_path(r'^endpoint/', view)
  const djangoPath = /\bpath\s*\(\s*(['"`r])(['"`]?)([^'"` \n)]+)\2/g;
  for (const match of text.matchAll(djangoPath)) {
    const routePath = match[3];
    const lineNumber = getLineNumber(text, match.index);
    endpoints.push(makeEndpoint("GET", routePath, filePath, lineNumber));
  }

  // Django REST Framework: router.register(r'path', ViewSetClass, ...)
  // Generates list (GET/POST) and detail (GET/PUT/PATCH/DELETE) endpoints per registered prefix.
  // Apply djangoPrefix (from the path('prefix/', include(...)) in the top-level urls.py).
  const drfRegister = /\w+\.register\s*\(\s*r?(['"`])([^'"` \n)]+)\1\s*,\s*(\w+)/g;
  for (const match of text.matchAll(drfRegister)) {
    const localPrefix = match[2];
    const viewSetName = match[3];
    const lineNumber = getLineNumber(text, match.index);
    const fullPrefix = djangoPrefix ? `${djangoPrefix}/${localPrefix}` : localPrefix;
    for (const httpMethod of ["GET", "POST"]) {
      endpoints.push({
        ...makeEndpoint(httpMethod, `/${fullPrefix}/`, filePath, lineNumber),
        className: viewSetName,
        routerGenerated: true,
      });
    }
    for (const httpMethod of ["GET", "PUT", "PATCH", "DELETE"]) {
      endpoints.push({
        ...makeEndpoint(httpMethod, `/${fullPrefix}/{}/`, filePath, lineNumber),
        className: viewSetName,
        routerGenerated: true,
      });
    }
  }
}

function makeEndpoint(httpMethod, routePath, filePath, lineNumber) {
  return {
    id: `Endpoint:${filePath}:${httpMethod}:${routePath}:${lineNumber}`,
    httpMethod: httpMethod.toUpperCase(),
    path: routePath,
    fullPath: normalizePath(routePath),
    className: null,
    methodName: null,
    filePath,
    line: lineNumber,
  };
}

// ---------------------------------------------------------------------------
// HTTP client extraction
// ---------------------------------------------------------------------------

/**
 * Build a map of variable assignments that look like URL assignments.
 * Handles:
 *   url = f'{CONSTANT}/some/path'
 *   url = f"{settings.CONSTANT}/some/path"
 *   url = CONSTANT + '/some/path'
 *
 * Returns Map<varName, {urlExpression: string, path: string}>
 */
function buildUrlVarMap(text) {
  const map = new Map();

  // f-string: varname = f'{expr}/path' or varname = f"{expr}/path"
  // Captures first interpolation expression and the literal path portion that follows.
  const fstringAssign = /^[ \t]*(\w+)\s*=\s*f["'](?:\{([^}]+)\})?([^"'\n]*)["']/gm;
  for (const m of text.matchAll(fstringAssign)) {
    const varName = m[1];
    const expr = (m[2] || "").trim();
    const rest = (m[3] || "").split(/["']/)[0]; // stop at stray quote
    // Only record if there's a useful expression or the rest looks like a URL path
    if (expr || rest.startsWith("/")) {
      map.set(varName, { urlExpression: expr, path: rest });
    }
  }

  // Concatenation: varname = CONSTANT + '/path'
  const concatAssign = /^[ \t]*(\w+)\s*=\s*([A-Z_][A-Z0-9_.]+)\s*\+\s*["']([^"'\n]*)["']/gm;
  for (const m of text.matchAll(concatAssign)) {
    const varName = m[1];
    const constant = m[2];
    const pathPart = m[3];
    if (pathPart.startsWith("/")) {
      map.set(varName, { urlExpression: constant, path: pathPart });
    }
  }

  return map;
}

function extractClients(text, filePath, clients) {
  // Detect imports of HTTP client libraries
  const importedAliases = new Map(); // alias → lib name

  // import requests, import httpx, import aiohttp
  for (const match of text.matchAll(
    /^import\s+(requests|httpx|aiohttp|urllib(?:\.\w+)?)\s*(?:as\s+(\w+))?/gm,
  )) {
    const lib = match[1];
    const alias = match[2] || lib.split(".")[0];
    importedAliases.set(alias, lib);
  }

  // from requests import Session, from httpx import AsyncClient
  for (const match of text.matchAll(
    /^from\s+(requests|httpx|aiohttp|urllib(?:\.\w+)?)\s+import\s+(\w+)(?:\s+as\s+(\w+))?/gm,
  )) {
    const lib = match[1];
    const alias = match[3] || match[2];
    importedAliases.set(alias, lib);
  }

  if (importedAliases.size === 0) {
    return;
  }

  // Detect session / client objects created from HTTP libraries:
  // session = requests.Session()  or  client = httpx.AsyncClient()
  for (const [alias] of importedAliases) {
    for (const m of text.matchAll(
      new RegExp(`(\\w+)\\s*=\\s*${escapeRegex(alias)}\\s*\\.\\s*(?:Session|AsyncClient|Client|ClientSession)\\s*\\(`, "gi"),
    )) {
      const sessionVar = m[1];
      if (!importedAliases.has(sessionVar)) {
        importedAliases.set(sessionVar, alias);
      }
    }
  }

  // Build URL variable assignment map for this file
  const urlVarMap = buildUrlVarMap(text);

  for (const [alias] of importedAliases) {
    // ── Pattern A: literal string URL ──────────────────────────────────────
    // requests.get('url'), httpx.post('url'), etc.
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

    // ── Pattern B: variable URL ─────────────────────────────────────────────
    // requests.get(url_var)  /  requests.get(url=url_var)
    // session.get(url=some_var)
    const varCallPattern = new RegExp(
      `${escapeRegex(alias)}\\s*\\.\\s*(get|post|put|patch|delete|head|options)\\s*\\(\\s*(?:url\\s*=\\s*)?(\\b(?!f["'])\\w+\\b)`,
      "gi",
    );
    for (const match of text.matchAll(varCallPattern)) {
      const httpMethod = match[1].toUpperCase();
      const urlVar = match[2];
      // Skip obviously-not-URL identifiers
      if (["True", "False", "None", "self", "cls", "request", "response", "data", "payload"].includes(urlVar)) continue;
      // Only proceed if we know this variable is URL-related
      if (!urlVarMap.has(urlVar)) continue;
      const lineNumber = getLineNumber(text, match.index);
      const urlInfo = urlVarMap.get(urlVar);
      clients.push({
        id: `Client:${filePath}:${alias}:var:${lineNumber}`,
        clientName: urlVar,
        urlExpression: urlInfo.urlExpression || urlVar,
        baseUrl: null,
        fullPath: urlInfo.path ? normalizePath(urlInfo.path) : null,
        httpMethod,
        path: urlInfo.path ? normalizePath(urlInfo.path) : null,
        filePath,
        line: lineNumber,
        callSites: [],
      });
    }

    // ── Pattern C: requests.request("METHOD", url_var) ─────────────────────
    const requestVarPattern = new RegExp(
      `${escapeRegex(alias)}\\s*\\.\\s*request\\s*\\(\\s*(['"\`])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\1\\s*,\\s*(\\w+)`,
      "gi",
    );
    for (const match of text.matchAll(requestVarPattern)) {
      const httpMethod = match[2].toUpperCase();
      const urlVar = match[3];
      const lineNumber = getLineNumber(text, match.index);
      const urlInfo = urlVarMap.get(urlVar) || {};
      clients.push({
        id: `Client:${filePath}:${alias}:req:${lineNumber}`,
        clientName: urlVar,
        urlExpression: urlInfo.urlExpression || urlVar,
        baseUrl: null,
        fullPath: urlInfo.path ? normalizePath(urlInfo.path) : null,
        httpMethod,
        path: urlInfo.path ? normalizePath(urlInfo.path) : null,
        filePath,
        line: lineNumber,
        callSites: [],
      });
    }

    // ── Pattern D: inline f-string URL ─────────────────────────────────────
    // requests.get(f'{CONST}/path', ...)  /  session.get(url=f"{CONST}/path", ...)
    const fstringCallPattern = new RegExp(
      `${escapeRegex(alias)}\\s*\\.\\s*(get|post|put|patch|delete|head|options)\\s*\\(\\s*(?:url\\s*=\\s*)?f["'](?:\\{([^}]+)\\})?([^"'\\n]*)["']`,
      "gi",
    );
    for (const match of text.matchAll(fstringCallPattern)) {
      const httpMethod = match[1].toUpperCase();
      const urlExpression = (match[2] || "").trim();
      const pathPart = (match[3] || "").split(/["']/)[0];
      if (!urlExpression && !pathPart) continue;
      const lineNumber = getLineNumber(text, match.index);
      const normalizedPath = pathPart ? normalizePath(pathPart) : null;
      clients.push({
        id: `Client:${filePath}:${alias}:fstr:${lineNumber}`,
        clientName: urlExpression || alias,
        urlExpression,
        baseUrl: null,
        fullPath: normalizedPath,
        httpMethod,
        path: normalizedPath,
        filePath,
        line: lineNumber,
        callSites: [],
      });
    }
  }

  // ── Pattern E: URL path literals in HTTP-client-using files ────────────────
  // Scan for string literals that look like multi-segment URL paths.
  // These may appear in dictionaries or variables used indirectly in HTTP calls
  // (e.g. LAMBDA_ROUTER = {key: "/enrichments/predictors"}).
  const urlPathLiteral = /['"`](\/[a-z][a-z0-9_/-]{3,})['"`]/gi;
  for (const match of text.matchAll(urlPathLiteral)) {
    const rawPath = match[1];
    // Must have at least one interior slash (multi-segment)
    if (!rawPath.slice(1).includes("/")) continue;
    const lineNumber = getLineNumber(text, match.index);
    clients.push({
      id: `Client:${filePath}:path-lit:${lineNumber}`,
      clientName: "_path_literal",
      urlExpression: null,
      baseUrl: null,
      fullPath: normalizePath(rawPath),
      httpMethod: "GET", // method unknown; GET is the fallback for path-only matching
      path: normalizePath(rawPath),
      filePath,
      line: lineNumber,
      callSites: [],
    });
  }
}

// ---------------------------------------------------------------------------
// Django model extraction
// ---------------------------------------------------------------------------

function extractModels(text, filePath, classes) {
  // class ModelName(models.Model): or class ModelName(BaseModel): etc.
  const classPattern = /^class\s+(\w+)\s*\(([^)]+)\)\s*:/gm;
  for (const match of text.matchAll(classPattern)) {
    const className = match[1];
    const bases = match[2];
    // Only capture classes that inherit from a Model-like base
    if (!/[Mm]odel|[Ss]erializer|[Vv]iew[Ss]et|[Ff]orm/.test(bases)) {
      continue;
    }
    const lineNumber = getLineNumber(text, match.index);
    classes.push({
      id: `Class:${filePath}:${className}`,
      name: className,
      bases: bases.split(",").map((b) => b.trim()),
      filePath,
      line: lineNumber,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadEnvProperties(serviceRoot) {
  const props = {};
  const candidates = [".env", "config.py", "settings.py"];
  for (const filename of candidates) {
    const filePath = path.join(serviceRoot, filename);
    if (!(await pathExists(filePath))) {
      continue;
    }
    try {
      const text = await fs.readFile(filePath, "utf8");
      if (filename === ".env") {
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const idx = trimmed.indexOf("=");
          if (idx === -1) continue;
          const key = trimmed.slice(0, idx).trim();
          const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
          props[key] = value;
        }
      } else {
        // Python config/settings: PORT = 8000 or PORT = os.getenv(...)
        for (const match of text.matchAll(/^(PORT|HOST|DEBUG|SECRET_KEY)\s*=\s*(\d+|['"][^'"]+['"])/gm)) {
          props[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
        }
      }
    } catch {
      // best-effort
    }
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
