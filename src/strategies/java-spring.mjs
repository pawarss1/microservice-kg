/**
 * @file java-spring.mjs
 * Language strategy for Java/Spring Boot workspaces.
 *
 * Extracted verbatim from analyzer.mjs to conform to the LanguageStrategy interface.
 * All Java Spring parsing logic lives exclusively here.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  IGNORED_DIR_NAMES,
  pathExists,
  listFiles,
  walkDirectories,
  dedupeBy,
  firstDefined,
  deriveServiceAliases,
  normalizePath,
  joinPaths,
  resolveConfigValue,
  stripQuotes,
  sanitizeJavaType,
  readQueueConfig,
  mergeQueueBindings,
  extractStringList,
} from "./base.mjs";

const CONTROL_FLOW_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "try",
  "return",
  "throw",
  "new",
  "super",
  "this",
  "synchronized",
]);

const HTTP_METHOD_BY_ANNOTATION = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
};

// ---------------------------------------------------------------------------
// LanguageStrategy interface implementation
// ---------------------------------------------------------------------------

export const id = "java-spring";

export const indicatorFiles = ["pom.xml", "build.gradle", "build.gradle.kts"];

/**
 * Find all Spring Boot service roots within a workspace.
 *
 * @param {string} rootDir
 * @returns {Promise<string[]>}
 */
export async function discoverServiceRoots(rootDir) {
  const results = [];
  await walkDirectories(rootDir, async (dirPath, dirents) => {
    const names = new Set(dirents.map((dirent) => dirent.name));
    const hasSource = names.has("src");
    const hasBuildFile = names.has("build.gradle") || names.has("pom.xml") || names.has("build.gradle.kts");
    if (!hasSource || !hasBuildFile) {
      return false;
    }

    const javaRoot = path.join(dirPath, "src", "main", "java");
    if (!(await pathExists(javaRoot))) {
      return false;
    }

    const resourcesRoot = path.join(dirPath, "src", "main", "resources");
    const hasAppConfig = await hasApplicationConfig(resourcesRoot);
    const hasSpringBootApp = await hasSpringBootApplication(javaRoot);
    if (!hasAppConfig && !hasSpringBootApp) {
      return false;
    }

    results.push(dirPath);
    return true;
  });

  results.sort((left, right) => left.localeCompare(right));
  return results;
}

/**
 * Extract full service metadata for one Spring Boot service.
 *
 * @param {string} serviceRoot - Absolute path to the service directory
 * @param {string} workspaceRoot - Absolute path to the workspace root
 * @returns {Promise<Object|null>}
 */
export async function analyzeService(serviceRoot, workspaceRoot) {
  const javaRoot = path.join(serviceRoot, "src", "main", "java");
  const resourcesRoot = path.join(serviceRoot, "src", "main", "resources");
  const propertyMap = await loadServiceProperties(resourcesRoot);
  const javaFiles = await listFiles(javaRoot, (entry) => entry.isFile() && entry.name.endsWith(".java"));

  const parsedFiles = [];
  for (const filePath of javaFiles) {
    parsedFiles.push(await parseJavaFile(filePath, serviceRoot, propertyMap));
  }

  const serviceNameFromConfig = firstDefined(
    propertyMap["spring.application.name"],
    propertyMap["spring.application.name[0]"],
  );
  const serviceId = path.basename(serviceRoot);
  const aliases = deriveServiceAliases([serviceId, serviceNameFromConfig]);

  const classes = [];
  const methods = [];
  const endpoints = [];
  const clients = [];
  const fields = [];
  for (const parsedFile of parsedFiles) {
    classes.push(...parsedFile.classes);
    methods.push(...parsedFile.methods);
    endpoints.push(...parsedFile.endpoints);
    clients.push(...parsedFile.clients);
    fields.push(...parsedFile.fields);
  }

  const methodInteractions = buildMethodInteractions(methods, fields);
  const detectedQueueBindings = await extractJavaQueueBindings(javaFiles, propertyMap);
  const queueBindings = mergeQueueBindings(detectedQueueBindings, await readQueueConfig(serviceRoot));

  return {
    id: serviceId,
    name: serviceNameFromConfig || serviceId,
    rootDir: serviceRoot,
    relativeRootDir: path.relative(workspaceRoot, serviceRoot),
    aliases,
    properties: propertyMap,
    classes,
    fields,
    methods,
    endpoints,
    clients,
    methodInteractions,
    queueBindings,
  };
}

// ---------------------------------------------------------------------------
// Queue binding auto-detection (Java/Spring)
// ---------------------------------------------------------------------------

/**
 * Auto-detect queue publisher/subscriber bindings from Java source files.
 *
 * Subscriber annotations:
 *   @KafkaListener(topics = "name" | {"t1","t2"} | "${prop.key}")
 *   @RabbitListener(queues = "name" | {"q1","q2"})
 *   @SqsListener("name")
 *   @StreamListener("input")      — Spring Cloud Stream
 *
 * Publisher APIs:
 *   kafkaTemplate.send("topic", ...)
 *   rabbitTemplate.convertAndSend("exchange", ...)
 *   streamBridge.send("binding", ...)
 */
async function extractJavaQueueBindings(javaFiles, propertyMap) {
  const bindings = [];

  for (const filePath of javaFiles) {
    let text;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    if (!/Kafka|Rabbit|Sqs|StreamListener|Queue|Topic/i.test(text)) continue;

    // Build file-local String constants: static final String CONST = "value"
    const localConsts = new Map();
    for (const m of text.matchAll(/\bString\s+([A-Z][A-Z0-9_]+)\s*=\s*"([^"]+)"/g)) {
      localConsts.set(m[1], m[2]);
    }

    function resolveJavaTopic(raw) {
      const s = raw.trim().replace(/^["']|["']$/g, "");
      if (s.startsWith("${") && s.endsWith("}")) {
        const key = s.slice(2, -1).split(":")[0].trim();
        return propertyMap[key] || null;
      }
      if (/^[A-Z][A-Z0-9_]+$/.test(s)) {
        return localConsts.get(s) || null;
      }
      return s || null;
    }

    // @KafkaListener(topics = "name") or @KafkaListener(topics = {"t1","t2"})
    for (const m of text.matchAll(/@KafkaListener\s*\([^)]*\btopics\s*=\s*(\{[^}]+\}|"[^"]+"|'[^']+'|\$\{[^}]+\})/g)) {
      const raw = m[1].trim();
      if (raw.startsWith("{")) {
        for (const t of extractStringList(raw.slice(1, -1))) {
          const resolved = resolveJavaTopic(t);
          if (resolved) bindings.push({ channel: resolved, role: "subscriber" });
        }
      } else {
        const resolved = resolveJavaTopic(raw);
        if (resolved) bindings.push({ channel: resolved, role: "subscriber" });
      }
    }

    // @RabbitListener(queues = "name") or @RabbitListener(queues = {"q1","q2"})
    for (const m of text.matchAll(/@RabbitListener\s*\([^)]*\bqueues\s*=\s*(\{[^}]+\}|"[^"]+"|'[^']+')/g)) {
      const raw = m[1].trim();
      if (raw.startsWith("{")) {
        for (const t of extractStringList(raw.slice(1, -1))) {
          const resolved = resolveJavaTopic(t);
          if (resolved) bindings.push({ channel: resolved, role: "subscriber" });
        }
      } else {
        const resolved = resolveJavaTopic(raw);
        if (resolved) bindings.push({ channel: resolved, role: "subscriber" });
      }
    }

    // @SqsListener("queue-name")
    for (const m of text.matchAll(/@SqsListener\s*\(\s*"([^"]+)"/g)) {
      bindings.push({ channel: m[1], role: "subscriber" });
    }

    // @StreamListener("input")
    for (const m of text.matchAll(/@StreamListener\s*\(\s*"([^"]+)"/g)) {
      bindings.push({ channel: m[1], role: "subscriber" });
    }

    // kafkaTemplate.send("topic", ...) or anyKafkaTemplate.send(CONST, ...)
    for (const m of text.matchAll(/\w*[Kk]afka[Tt]emplate\w*\.send\s*\(\s*("([^"]+)"|([A-Z][A-Z0-9_]+))/g)) {
      const resolved = m[2] || resolveJavaTopic(m[3] || "");
      if (resolved) bindings.push({ channel: resolved, role: "publisher" });
    }

    // rabbitTemplate.convertAndSend / send — first string arg is exchange or queue
    for (const m of text.matchAll(/\w*[Rr]abbit[Tt]emplate\w*\.\w+\s*\(\s*"([^"]+)"/g)) {
      bindings.push({ channel: m[1], role: "publisher" });
    }

    // streamBridge.send("output-binding", payload)
    for (const m of text.matchAll(/\w*[Ss]tream[Bb]ridge\w*\.send\s*\(\s*"([^"]+)"/g)) {
      bindings.push({ channel: m[1], role: "publisher" });
    }
  }

  return bindings;
}

// ---------------------------------------------------------------------------
// Java parsing internals
// ---------------------------------------------------------------------------

function buildMethodInteractions(methods, fields) {
  const fieldMapByClass = new Map();
  for (const field of fields) {
    const key = field.className;
    if (!fieldMapByClass.has(key)) {
      fieldMapByClass.set(key, new Map());
    }
    fieldMapByClass.get(key).set(field.name, field.type);
  }

  const methodMapByClass = new Map();
  for (const method of methods) {
    if (!methodMapByClass.has(method.className)) {
      methodMapByClass.set(method.className, new Set());
    }
    methodMapByClass.get(method.className).add(method.name);
  }

  const interactions = [];
  for (const method of methods) {
    const fieldMap = fieldMapByClass.get(method.className) || new Map();
    const localMethods = methodMapByClass.get(method.className) || new Set();

    for (const call of method.calls) {
      if (call.receiver && fieldMap.has(call.receiver)) {
        interactions.push({
          type: "field-call",
          sourceMethodId: method.id,
          sourceClassName: method.className,
          sourceMethodName: method.name,
          targetClassName: sanitizeJavaType(fieldMap.get(call.receiver)),
          targetMethodName: call.method,
          filePath: method.filePath,
          line: call.line,
        });
      } else if (!call.receiver && localMethods.has(call.method) && call.method !== method.name) {
        interactions.push({
          type: "local-call",
          sourceMethodId: method.id,
          sourceClassName: method.className,
          sourceMethodName: method.name,
          targetClassName: method.className,
          targetMethodName: call.method,
          filePath: method.filePath,
          line: call.line,
        });
      }
    }
  }

  return dedupeBy(interactions, (interaction) =>
    [
      interaction.type,
      interaction.sourceMethodId,
      interaction.targetClassName,
      interaction.targetMethodName,
      interaction.line,
    ].join("|"),
  );
}

async function parseJavaFile(filePath, serviceRoot, propertyMap) {
  const text = await fs.readFile(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const packageMatch = text.match(/^\s*package\s+([\w.]+)\s*;/m);
  const imports = lines
    .filter((line) => line.trim().startsWith("import "))
    .map((line) => line.trim().replace(/^import\s+/, "").replace(/;$/, ""));

  const parsed = {
    filePath,
    relativeFilePath: path.relative(serviceRoot, filePath),
    packageName: packageMatch?.[1] || null,
    imports,
    classes: [],
    fields: [],
    methods: [],
    endpoints: [],
    clients: [],
  };

  let braceDepth = 0;
  let currentClass = null;
  let currentMethod = null;
  let declarationBuffer = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    const trimmed = line.trim();
    const nextBraceDepth = braceDepth + countBraces(line);

    if (currentMethod) {
      currentMethod.bodyLines.push({ lineNumber, line });
      currentMethod.calls.push(...extractCallsFromLine(line, lineNumber));
      braceDepth = nextBraceDepth;
      if (braceDepth < currentMethod.bodyBraceDepth) {
        finalizeMethod(currentMethod);
        parsed.methods.push(currentMethod);
        currentMethod = null;
      }
      continue;
    }

    if (trimmed) {
      declarationBuffer.push({ lineNumber, line });
    }

    const declarationComplete =
      Boolean(trimmed) && (trimmed.endsWith("{") || trimmed.endsWith(";"));
    if (declarationComplete && declarationBuffer.length > 0) {
      const declarationText = declarationBuffer.map((entry) => entry.line.trim()).join(" ");
      if (looksLikeClassDeclaration(declarationText)) {
        currentClass = parseClassDeclaration(
          declarationText,
          declarationBuffer[0].lineNumber,
          filePath,
          nextBraceDepth,
          propertyMap,
        );
        if (currentClass) {
          parsed.classes.push({
            id: `${currentClass.kind}:${filePath}:${currentClass.name}`,
            name: currentClass.name,
            kind: currentClass.kind,
            filePath,
            line: currentClass.line,
          });
        }
      } else if (currentClass && looksLikeMethodDeclaration(declarationText)) {
        const method = parseMethodDeclaration(
          declarationText,
          declarationBuffer[0].lineNumber,
          filePath,
          currentClass,
          propertyMap,
        );
        if (method) {
          if (method.endpoint) {
            parsed.endpoints.push(method.endpoint);
          }
          if (method.clientMethod) {
            parsed.clients.push(method.clientMethod);
          }
          if (declarationText.endsWith("{")) {
            currentMethod = {
              ...method,
              bodyBraceDepth: nextBraceDepth,
              bodyLines: [],
              calls: [],
            };
          } else {
            parsed.methods.push({
              ...method,
              calls: [],
            });
          }
        }
      } else if (currentClass) {
        const constant = parseStringConstant(declarationText);
        if (constant) {
          currentClass.constants.set(constant.name, constant.value);
        }
        const field = parseFieldDeclaration(
          declarationText,
          filePath,
          currentClass.name,
          declarationBuffer[0].lineNumber,
        );
        if (field) {
          parsed.fields.push(field);
        }
      }
      declarationBuffer = [];
    }

    braceDepth = nextBraceDepth;
    if (currentClass && braceDepth < currentClass.bodyBraceDepth) {
      currentClass = null;
    }
  }

  return parsed;
}

function parseClassDeclaration(declarationText, lineNumber, filePath, bodyBraceDepth, propertyMap) {
  const match = declarationText.match(/\b(class|interface|enum)\s+([A-Za-z_]\w*)\b/);
  if (!match) {
    return null;
  }
  const annotations = declarationText;
  const requestMapping = parseRequestMapping(annotations, null, propertyMap, new Map());
  const feignClient = parseFeignClient(annotations, propertyMap);
  return {
    name: match[2],
    kind: match[1],
    line: lineNumber,
    filePath,
    bodyBraceDepth,
    basePath: requestMapping?.fullPath || "",
    feignClient,
    constants: new Map(),
  };
}

function parseMethodDeclaration(declarationText, lineNumber, filePath, currentClass, propertyMap) {
  const methodName = extractMethodName(declarationText, currentClass.name);
  if (!methodName) {
    return null;
  }

  const endpoint = parseRequestMapping(
    declarationText,
    currentClass.basePath,
    propertyMap,
    currentClass.constants,
  );

  const id = `Method:${filePath}:${currentClass.name}:${methodName}:${lineNumber}`;
  const method = {
    id,
    className: currentClass.name,
    name: methodName,
    filePath,
    line: lineNumber,
  };

  if (endpoint) {
    method.endpoint = {
      id: `Endpoint:${filePath}:${currentClass.name}:${methodName}:${lineNumber}`,
      servicePathId: `${endpoint.httpMethod}:${normalizePath(endpoint.fullPath)}`,
      className: currentClass.name,
      methodName,
      filePath,
      line: lineNumber,
      ...endpoint,
    };
  }

  if (currentClass.feignClient) {
    const clientMapping = parseRequestMapping(
      declarationText,
      currentClass.feignClient.path || "",
      propertyMap,
      currentClass.constants,
    );
    if (clientMapping) {
      method.clientMethod = {
        id: `ClientMethod:${filePath}:${currentClass.name}:${methodName}:${lineNumber}`,
        className: currentClass.name,
        methodName,
        filePath,
        line: lineNumber,
        feignName: currentClass.feignClient.name,
        urlExpression: currentClass.feignClient.urlExpression,
        resolvedBaseUrl: currentClass.feignClient.resolvedBaseUrl,
        pathExpression: clientMapping.rawPath,
        resolvedPath: clientMapping.resolvedPath,
        fullPath: clientMapping.fullPath,
        httpMethod: clientMapping.httpMethod,
      };
    }
  }

  return method;
}

function finalizeMethod(method) {
  delete method.bodyBraceDepth;
  delete method.bodyLines;
}

function parseFieldDeclaration(declarationText, filePath, className, lineNumber) {
  const fieldMatch = declarationText.match(
    /(?:private|protected|public)?\s*(?:static\s+)?(?:final\s+)?([A-Za-z_][\w.$<>\[\], ?]+)\s+([a-zA-Z_]\w*)\s*(?:=.*)?;$/,
  );
  if (!fieldMatch) {
    return null;
  }

  const fieldName = fieldMatch[2];
  if (fieldName.toUpperCase() === fieldName) {
    return null;
  }

  return {
    id: `Field:${filePath}:${className}:${fieldName}:${lineNumber}`,
    className,
    name: fieldName,
    type: sanitizeJavaType(fieldMatch[1]),
    filePath,
    line: lineNumber,
  };
}

function parseStringConstant(declarationText) {
  const match = declarationText.match(
    /(?:private|protected|public)?\s*(?:static\s+)?(?:final\s+)?String\s+([A-Z0-9_]+)\s*=\s*"([^"]*)";$/,
  );
  if (!match) {
    return null;
  }

  return {
    name: match[1],
    value: match[2],
  };
}

function looksLikeClassDeclaration(declarationText) {
  return /\b(class|interface|enum)\s+[A-Za-z_]\w*\b/.test(declarationText);
}

function looksLikeMethodDeclaration(declarationText) {
  if (
    !declarationText.includes("(") ||
    (!declarationText.endsWith("{") && !declarationText.endsWith(";"))
  ) {
    return false;
  }
  if (looksLikeClassDeclaration(declarationText)) {
    return false;
  }
  const lowered = declarationText.toLowerCase();
  for (const keyword of CONTROL_FLOW_KEYWORDS) {
    if (lowered.startsWith(`${keyword} `) || lowered.startsWith(`${keyword}(`)) {
      return false;
    }
  }
  return true;
}

function extractMethodName(declarationText, className) {
  const constructorMatch = declarationText.match(
    new RegExp(`\\b${className}\\s*\\(([^)]*)\\)\\s*(?:throws [^;{]+)?[;{]$`),
  );
  if (constructorMatch) {
    return className;
  }

  const methodMatch = declarationText.match(
    /(?:public|protected|private|static|final|native|synchronized|abstract|default|strictfp|\s)+(?:<[^>]+>\s*)?(?:[\w.$<>\[\],?@]+\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:throws [^;{]+)?[;{]$/,
  );
  return methodMatch?.[1] || null;
}

function parseFeignClient(declarationText, propertyMap) {
  const annotationArgs = extractAnnotationArguments(declarationText, "FeignClient");
  if (annotationArgs === null) {
    return null;
  }

  const urlExpression = extractAnnotationValue(annotationArgs, "url");
  const pathExpression =
    extractAnnotationValue(annotationArgs, "path") ||
    extractAnnotationValue(annotationArgs, "value") ||
    "";
  return {
    name:
      extractAnnotationValue(annotationArgs, "name") ||
      extractAnnotationValue(annotationArgs, "value") ||
      null,
    urlExpression,
    resolvedBaseUrl: resolveConfigValue(urlExpression || "", propertyMap),
    path: normalizePath(resolveConfigValue(pathExpression || "", propertyMap)),
  };
}

function parseRequestMapping(declarationText, basePath, propertyMap, constants) {
  for (const [annotationName, httpMethod] of Object.entries(HTTP_METHOD_BY_ANNOTATION)) {
    const annotationArgs = extractAnnotationArguments(declarationText, annotationName);
    if (annotationArgs !== null) {
      const rawPath = extractMappingPath(annotationArgs, constants);
      const resolvedPath = resolveConfigValue(rawPath || "", propertyMap);
      return {
        annotationName,
        httpMethod,
        rawPath,
        resolvedPath,
        fullPath: joinPaths(basePath, resolvedPath),
      };
    }
  }

  const requestMappingArgs = extractAnnotationArguments(declarationText, "RequestMapping");
  if (requestMappingArgs === null) {
    return null;
  }

  const rawPath = extractMappingPath(requestMappingArgs, constants);
  const resolvedPath = resolveConfigValue(rawPath || "", propertyMap);
  const methodValue = extractAnnotationRequestMethod(requestMappingArgs) || "GET";

  return {
    annotationName: "RequestMapping",
    httpMethod: methodValue,
    rawPath,
    resolvedPath,
    fullPath: joinPaths(basePath, resolvedPath),
  };
}

function extractAnnotationArguments(text, annotationName) {
  // Match with parentheses: @Annotation(args) or @Annotation()
  const withParens = new RegExp(`@${annotationName}\\(([^)]*)\\)`);
  const matchWithParens = text.match(withParens);
  if (matchWithParens) {
    return matchWithParens[1];
  }
  // Match without parentheses: @Annotation (standalone, no args)
  const withoutParens = new RegExp(`@${annotationName}(?!\\()\\b`);
  if (withoutParens.test(text)) {
    return ""; // empty args — annotation present with no arguments
  }
  return null;
}

function extractAnnotationRequestMethod(annotationArgs) {
  const match = annotationArgs.match(/RequestMethod\.([A-Z]+)/);
  return match?.[1] || null;
}

function extractAnnotationValue(annotationArgs, key) {
  const namedMatch = annotationArgs.match(
    new RegExp(`${key}\\s*=\\s*("([^"]*)"|'([^']*)'|\\$\\{[^}]+\\}|[A-Za-z0-9_.-]+)`),
  );
  if (namedMatch) {
    return stripQuotes(namedMatch[1]);
  }

  if (key === "value") {
    const positionalMatch = annotationArgs.match(
      /^("([^"]*)"|'([^']*)'|\$\{[^}]+\}|[A-Za-z0-9_.-]+)/,
    );
    if (positionalMatch) {
      return stripQuotes(positionalMatch[1]);
    }
  }

  return null;
}

function extractMappingPath(annotationArgs, constants) {
  const value =
    extractAnnotationValue(annotationArgs, "path") || extractAnnotationValue(annotationArgs, "value");
  if (!value) {
    return "";
  }

  if (constants.has(value)) {
    return constants.get(value);
  }

  return value;
}

function extractCallsFromLine(line, lineNumber) {
  const calls = [];
  const receiverRegex = /\b([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(/g;
  for (const match of line.matchAll(receiverRegex)) {
    calls.push({
      receiver: match[1],
      method: match[2],
      line: lineNumber,
    });
  }

  const directRegex = /(^|[^.])\b([A-Za-z_]\w*)\s*\(/g;
  for (const match of line.matchAll(directRegex)) {
    const methodName = match[2];
    if (CONTROL_FLOW_KEYWORDS.has(methodName)) {
      continue;
    }
    calls.push({
      receiver: null,
      method: methodName,
      line: lineNumber,
    });
  }

  return dedupeBy(calls, (call) => `${call.receiver || ""}:${call.method}:${call.line}`);
}

async function loadServiceProperties(resourcesRoot) {
  if (!(await pathExists(resourcesRoot))) {
    return {};
  }

  const configFiles = await listFiles(
    resourcesRoot,
    (entry) =>
      entry.isFile() && /^(application|bootstrap).*\.(properties|yml|yaml)$/.test(entry.name),
  );
  configFiles.sort((left, right) => left.localeCompare(right));

  const propertyMap = {};
  for (const filePath of configFiles) {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = filePath.endsWith(".properties") ? parseProperties(text) : parseYamlLike(text);
    Object.assign(propertyMap, parsed);
  }

  return propertyMap;
}

function parseProperties(text) {
  const properties = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    const fallbackSeparatorIndex = line.indexOf(":");
    const index =
      separatorIndex >= 0
        ? separatorIndex
        : fallbackSeparatorIndex >= 0
          ? fallbackSeparatorIndex
          : -1;
    if (index === -1) {
      continue;
    }

    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    properties[key] = stripQuotes(value);
  }
  return properties;
}

function parseYamlLike(text) {
  const properties = {};
  const stack = [{ indent: -1, key: "" }];

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) {
      continue;
    }

    const indent = rawLine.match(/^\s*/)?.[0]?.length || 0;
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("- ")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parentPath = stack[stack.length - 1].key;
    const fullKey = parentPath ? `${parentPath}.${key}` : key;

    if (!rawValue) {
      stack.push({ indent, key: fullKey });
      continue;
    }

    properties[fullKey] = stripQuotes(rawValue);
  }

  return properties;
}

async function hasApplicationConfig(resourcesRoot) {
  if (!(await pathExists(resourcesRoot))) {
    return false;
  }
  const files = await fs.readdir(resourcesRoot);
  return files.some((fileName) =>
    /^(application|bootstrap).*\.(properties|yml|yaml)$/.test(fileName),
  );
}

async function hasSpringBootApplication(javaRoot) {
  const javaFiles = await listFiles(
    javaRoot,
    (entry) => entry.isFile() && entry.name.endsWith(".java"),
  );
  for (const filePath of javaFiles.slice(0, 200)) {
    const text = await fs.readFile(filePath, "utf8");
    if (text.includes("@SpringBootApplication")) {
      return true;
    }
  }
  return false;
}

function countBraces(line) {
  const sanitized = line
    .replace(/"([^"\\]|\\.)*"/g, "")
    .replace(/'([^'\\]|\\.)*'/g, "")
    .replace(/\/\/.*$/g, "");
  let count = 0;
  for (const character of sanitized) {
    if (character === "{") {
      count += 1;
    } else if (character === "}") {
      count -= 1;
    }
  }
  return count;
}
