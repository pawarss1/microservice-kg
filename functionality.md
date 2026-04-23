# microservice-kg — Functionality Overview

## What It Does

`microservice-kg` is a command-line tool that statically analyzes microservice workspaces and generates a **knowledge graph** of your services — their HTTP endpoints, cross-service dependencies, and inter-service call relationships. It produces both a machine-readable JSON graph and a human-readable Markdown summary.

## Supported Languages

The tool is language-agnostic and currently supports:

| Language    | Detection Files                               | Framework Support                |
|-------------|-----------------------------------------------|----------------------------------|
| Java/Spring | `pom.xml`, `build.gradle`, `build.gradle.kts` | Spring MVC, Feign clients        |
| Node.js     | `package.json`                                | Express, Fastify, Koa, Hono      |
| Python      | `pyproject.toml`, `requirements.txt`, etc.   | Flask, FastAPI, Django           |

Language detection is automatic — the tool scores indicator files found in the workspace and picks the best match. You can also force a specific language with `--language`.

## What It Extracts

For each service discovered in your workspace:

- **Service identity** — name, version, and aliases used for fuzzy cross-service matching
- **HTTP endpoints** — routes defined via framework-specific decorators or method calls, with HTTP verb and path
- **HTTP clients** — imports of outbound HTTP client libraries (Feign, axios, requests, httpx, aiohttp, etc.) and their call targets
- **Cross-service edges** — resolved inter-service dependency relationships built by matching clients to known service aliases
- **Configuration** — port, host, and other properties from `.properties`, `.yml`, or `.env` files

## Output

A successful analysis writes two artifacts:

| File                | Format   | Purpose                                               |
|---------------------|----------|-------------------------------------------------------|
| `service-graph.json`| JSON     | Full knowledge graph — machine-readable, schema v1    |
| `summary.md`        | Markdown | Mermaid dependency diagram + per-service statistics   |

### JSON Schema (top-level)

```json
{
  "version": 1,
  "generatedAt": "<ISO 8601>",
  "inputDir": "/absolute/path/to/workspace",
  "serviceCount": 3,
  "services": [
    {
      "id": "order-service",
      "name": "order-service",
      "version": "1.0.0",
      "language": "java-spring | nodejs | python",
      "aliases": ["order", "orderservice"],
      "endpoints": [
        { "path": "/orders", "httpMethod": "GET" },
        { "path": "/orders/{id}", "httpMethod": "POST" }
      ],
      "clients": [
        { "clientName": "InventoryClient", "baseUrl": "http://inventory-service:8080" }
      ],
      "properties": { "server.port": "8081" }
    }
  ],
  "serviceEdges": [
    { "from": "order-service", "to": "inventory-service", "label": "HTTP" }
  ]
}
```

## CLI Usage

```bash
# Auto-detect language and analyze workspace
microservice-kg analyze ./my-workspace

# Force a specific language
microservice-kg analyze --language nodejs ./my-workspace

# Print JSON to stdout (pipe-friendly, CI/CD)
microservice-kg analyze --stdout ./my-workspace > context.json

# Verbose mode — shows detection details and scan progress on stderr
microservice-kg analyze --verbose ./my-workspace

# Structured NDJSON logs on stderr (for log aggregators / observability)
microservice-kg analyze --json-logs --output /tmp/kg ./my-workspace
```

## Exit Codes

| Code | Meaning                                       |
|------|-----------------------------------------------|
| 0    | Success                                       |
| 1    | Parse or extraction error                     |
| 2    | Language detection failed or unsupported      |
| 3    | I/O error (file not found, permission denied) |

## MCP Server

Run `microservice-kg-mcp` to expose the knowledge graph over the **Model Context Protocol**, allowing AI coding agents (Claude, Copilot, etc.) to query your service topology as structured context.

## Obsidian Export

Run `microservice-kg export-obsidian` to write the knowledge graph into an **Obsidian vault** for visual graph exploration using Obsidian's built-in graph view.

## Architecture — Adding a New Language

The tool uses the **Language Strategy pattern**. Each language is a self-contained module in `src/strategies/` that exports three things:

| Export                 | Signature                                            | Purpose                                          |
|------------------------|------------------------------------------------------|--------------------------------------------------|
| `id`                   | `string`                                             | Unique language identifier                       |
| `indicatorFiles`       | `string[]`                                           | Files that signal this language is in use        |
| `discoverServiceRoots` | `(rootDir: string) => Promise<string[]>`             | Find all service directories in the workspace    |
| `analyzeService`       | `(serviceRoot, workspaceRoot) => Promise<Service>`   | Extract endpoints, clients, and metadata         |

To add support for a new language:

1. Create `src/strategies/<lang>.mjs` implementing the interface above
2. Add its indicator files and scores to `src/detector.mjs`
3. Register the strategy in the `STRATEGIES` map in `src/analyzer.mjs`

No changes to the core pipeline, output schema, or CLI are required.
