import fs from "node:fs/promises";
import path from "node:path";

const IGNORED_DIR_NAMES = new Set([
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
]);

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

export async function analyzeWorkspace(inputDir) {
  const serviceRoots = await discoverServiceRoots(inputDir);
  const services = [];

  for (const serviceRoot of serviceRoots) {
    const service = await analyzeService(inputDir, serviceRoot);
    if (service) {
      services.push(service);
    }
  }

  const serviceEdges = buildServiceEdges(services);
  const graph = {
    version: 1,
    generatedAt: new Date().toISOString(),
    inputDir,
    serviceCount: services.length,
    serviceEdges,
    services,
  };

  return graph;
}

export async function writeGraphArtifacts(graph, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, "service-graph.json"),
    `${JSON.stringify(graph, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(outputDir, "summary.md"),
    `${renderSummary(graph)}\n`,
    "utf8",
  );
}

async function discoverServiceRoots(rootDir) {
  const results = [];
  await walkDirectories(rootDir, async (dirPath, dirents) => {
    const names = new Set(dirents.map((dirent) => dirent.name));
    const hasSource = names.has("src");
    const hasBuildFile = names.has("build.gradle") || names.has("pom.xml");
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

async function analyzeService(inputDir, serviceRoot) {
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
  const aliases = deriveServiceAliases([
    serviceId,
    serviceNameFromConfig,
  ]);

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

  return {
    id: serviceId,
    name: serviceNameFromConfig || serviceId,
    rootDir: serviceRoot,
    relativeRootDir: path.relative(inputDir, serviceRoot),
    aliases,
    properties: propertyMap,
    classes,
    fields,
    methods,
    endpoints,
    clients,
    methodInteractions,
  };
}

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

  return dedupeBy(interactions, (interaction) => [
    interaction.type,
    interaction.sourceMethodId,
    interaction.targetClassName,
    interaction.targetMethodName,
    interaction.line,
  ].join("|"));
}

function buildServiceEdges(services) {
  const endpointsByMethodAndPath = new Map();
  const aliasIndex = new Map();

  for (const service of services) {
    for (const alias of service.aliases) {
      aliasIndex.set(alias, service.id);
    }
    for (const endpoint of service.endpoints) {
      const key = `${endpoint.httpMethod}:${normalizePath(endpoint.fullPath)}`;
      if (!endpointsByMethodAndPath.has(key)) {
        endpointsByMethodAndPath.set(key, []);
      }
      endpointsByMethodAndPath.get(key).push({
        serviceId: service.id,
        endpoint,
      });
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
      const callSites = findCallSitesForClientMethod(service, client);
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
      edge.reasons.push({
        type: "feign-client",
        clientClassName: client.className,
        clientMethodName: client.methodName,
        httpMethod: client.httpMethod,
        path: client.fullPath,
      });
      edge.calls.push({
        httpMethod: client.httpMethod,
        path: client.fullPath,
        sourceClassName: client.className,
        sourceMethodName: client.methodName,
        sourceFilePath: client.filePath,
        callSites,
        provider: provider
          ? {
              targetClassName: provider.className,
              targetMethodName: provider.methodName,
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
      .filter((field) => sanitizeJavaType(field.type) === clientMethod.className)
      .map((field) => field.name);

    for (const call of method.calls) {
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
  const key = `${client.httpMethod}:${normalizePath(client.fullPath)}`;
  const providerEntries = endpointsByMethodAndPath.get(key) || [];
  const provider = providerEntries.find((entry) => entry.serviceId === targetServiceId);
  if (provider?.endpoint) {
    return provider.endpoint;
  }

  const targetService = services.find((service) => service.id === targetServiceId);
  if (!targetService) {
    return null;
  }

  const clientPath = normalizePath(client.fullPath);
  return targetService.endpoints.find((endpoint) => {
    if (endpoint.httpMethod !== client.httpMethod) {
      return false;
    }
    const endpointPath = normalizePath(endpoint.fullPath);
    return (
      clientPath.endsWith(endpointPath)
      || endpointPath.endsWith(clientPath)
    );
  }) || null;
}

function resolveTargetServiceId(client, services, aliasIndex, endpointsByMethodAndPath) {
  const candidateStrings = [
    client.feignName,
    client.urlExpression,
    client.resolvedBaseUrl,
    client.pathExpression,
    client.resolvedPath,
  ].filter(Boolean);

  const candidateScores = new Map();
  for (const candidateString of candidateStrings) {
    const haystack = candidateString.toLowerCase();
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

  const key = `${client.httpMethod}:${normalizePath(client.fullPath)}`;
  const providers = endpointsByMethodAndPath.get(key) || [];
  if (providers.length === 1) {
    return providers[0].serviceId;
  }

  return aliasIndex.get(normalizeAlias(client.feignName || "")) || null;
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

    const declarationComplete = Boolean(trimmed) && (trimmed.endsWith("{") || trimmed.endsWith(";"));
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
        const field = parseFieldDeclaration(declarationText, filePath, currentClass.name, declarationBuffer[0].lineNumber);
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
  if (!annotationArgs) {
    return null;
  }

  const urlExpression = extractAnnotationValue(annotationArgs, "url");
  const pathExpression = extractAnnotationValue(annotationArgs, "path")
    || extractAnnotationValue(annotationArgs, "value")
    || "";
  return {
    name: extractAnnotationValue(annotationArgs, "name")
      || extractAnnotationValue(annotationArgs, "value")
      || null,
    urlExpression,
    resolvedBaseUrl: resolveConfigValue(urlExpression || "", propertyMap),
    path: normalizePath(resolveConfigValue(pathExpression || "", propertyMap)),
  };
}

function parseRequestMapping(declarationText, basePath, propertyMap, constants) {
  for (const [annotationName, httpMethod] of Object.entries(HTTP_METHOD_BY_ANNOTATION)) {
    const annotationArgs = extractAnnotationArguments(declarationText, annotationName);
    if (annotationArgs) {
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
  if (!requestMappingArgs) {
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
  const regex = new RegExp(`@${annotationName}\\(([^)]*)\\)`);
  const match = text.match(regex);
  return match?.[1] || null;
}

function extractAnnotationRequestMethod(annotationArgs) {
  const match = annotationArgs.match(/RequestMethod\.([A-Z]+)/);
  return match?.[1] || null;
}

function extractAnnotationValue(annotationArgs, key) {
  const namedMatch = annotationArgs.match(new RegExp(`${key}\\s*=\\s*("([^"]*)"|'([^']*)'|\\$\\{[^}]+\\}|[A-Za-z0-9_.-]+)`));
  if (namedMatch) {
    return stripQuotes(namedMatch[1]);
  }

  if (key === "value") {
    const positionalMatch = annotationArgs.match(/^("([^"]*)"|'([^']*)'|\$\{[^}]+\}|[A-Za-z0-9_.-]+)/);
    if (positionalMatch) {
      return stripQuotes(positionalMatch[1]);
    }
  }

  return null;
}

function extractMappingPath(annotationArgs, constants) {
  const value = extractAnnotationValue(annotationArgs, "path")
    || extractAnnotationValue(annotationArgs, "value");
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

  const configFiles = await listFiles(resourcesRoot, (entry) =>
    entry.isFile() && /^(application|bootstrap).*\.(properties|yml|yaml)$/.test(entry.name),
  );
  configFiles.sort((left, right) => left.localeCompare(right));

  const propertyMap = {};
  for (const filePath of configFiles) {
    const text = await fs.readFile(filePath, "utf8");
    const parsed =
      filePath.endsWith(".properties")
        ? parseProperties(text)
        : parseYamlLike(text);
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

function renderSummary(graph) {
  const lines = [
    "# Microservice KG Summary",
    "",
    `- Generated at: ${graph.generatedAt}`,
    `- Input directory: ${graph.inputDir}`,
    `- Services discovered: ${graph.serviceCount}`,
    `- Service edges discovered: ${graph.serviceEdges.length}`,
    "",
    "## Service Graph",
    "",
    "```mermaid",
    "graph LR",
  ];

  for (const edge of graph.serviceEdges) {
    lines.push(`  ${safeMermaidId(edge.sourceServiceId)}["${edge.sourceServiceId}"] -->|HTTP| ${safeMermaidId(edge.targetServiceId)}["${edge.targetServiceId}"]`);
  }
  lines.push("```", "", "## Services", "");

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
      lines.push(`- Client: ${call.sourceClassName}.${call.sourceMethodName}`);
      if (call.provider) {
        lines.push(`- Provider: ${call.provider.targetClassName}.${call.provider.targetMethodName}`);
      }
      if (call.callSites.length > 0) {
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

function deriveServiceAliases(values) {
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
  }
  return Array.from(aliases).filter(Boolean).sort((left, right) => left.localeCompare(right));
}

function normalizeAlias(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function joinPaths(basePath, pathValue) {
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

function normalizePath(value) {
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

function resolveConfigValue(rawValue, propertyMap) {
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

function stripQuotes(value) {
  return String(value || "").replace(/^['"]|['"]$/g, "");
}

function sanitizeJavaType(value) {
  return String(value || "")
    .replace(/<.*>/g, "")
    .replace(/\[\]/g, "")
    .split(".")
    .pop()
    .trim();
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

async function walkDirectories(rootDir, visitor) {
  const dirents = await fs.readdir(rootDir, { withFileTypes: true });
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

async function listFiles(rootDir, predicate) {
  const files = [];
  if (!(await pathExists(rootDir))) {
    return files;
  }

  async function walk(currentDir) {
    const dirents = await fs.readdir(currentDir, { withFileTypes: true });
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

async function hasApplicationConfig(resourcesRoot) {
  if (!(await pathExists(resourcesRoot))) {
    return false;
  }
  const files = await fs.readdir(resourcesRoot);
  return files.some((fileName) => /^(application|bootstrap).*\.(properties|yml|yaml)$/.test(fileName));
}

async function hasSpringBootApplication(javaRoot) {
  const javaFiles = await listFiles(javaRoot, (entry) => entry.isFile() && entry.name.endsWith(".java"));
  for (const filePath of javaFiles.slice(0, 200)) {
    const text = await fs.readFile(filePath, "utf8");
    if (text.includes("@SpringBootApplication")) {
      return true;
    }
  }
  return false;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function dedupeBy(values, keyFn) {
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

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}
