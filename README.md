# microservice-kg

`microservice-kg` builds a consolidated knowledge graph for a directory containing many services.

It is designed for multi-repo microservice workspaces where static code reasoning needs to happen at two levels at once:

- service-to-service dependencies
- class and method evidence behind each dependency

The first version focuses on Java/Spring microservices and produces:

- service inventory
- HTTP provider endpoints
- HTTP client edges via `@FeignClient`
- method-level evidence for each cross-service edge
- in-service class and method interaction edges

## Why this exists

Tools like GitNexus are strong inside a single repo. This project adds a service-aware layer on top of a multi-repo workspace so you can answer:

- which services call which other services
- which class and method create that dependency
- which controller method receives the traffic on the target side

That becomes valuable when a change crosses service boundaries and code search alone is not enough.

## Why this is useful for agentic coding

Agentic coding systems are good at editing code, but they often lack a durable architecture view across many services.

That creates a predictable failure mode:

- the agent finds one caller and assumes it is the only caller
- the agent edits one repo without seeing the upstream or downstream service contract
- the agent invents likely service relationships that are not actually present in code

`microservice-kg` reduces that failure mode by turning service dependencies into queryable graph data.

With this graph, an agent can:

- list all logical services in a workspace
- inspect incoming and outgoing dependencies of a service
- inspect the exact edge between two services
- find paths between services
- compute service-level blast radius before changing a contract

## How this helps avoid hallucination

This project does not try to "guess" architecture from naming alone. It anchors graph edges in code evidence:

- Spring controllers and request mappings define provider endpoints
- Feign clients define outbound service calls
- method-level call-site inference identifies which class and method actually trigger a cross-service dependency

That means an agent can answer:

- "Does service A really call service B?"
- "Which method does it call?"
- "Who in the source repo triggers that call?"

with evidence instead of speculation.

This does not eliminate hallucination entirely, but it narrows the space in which an agent has to infer behavior.

## Usage

```bash
node src/cli.mjs analyze /path/to/workspace
```

Optional output directory:

```bash
node src/cli.mjs analyze /path/to/workspace --output /path/to/output
```

The analyzer writes:

- `service-graph.json`
- `summary.md`

## Example workflow

Analyze a workspace:

```bash
node src/cli.mjs analyze /Users/me/workspace/services
```

Export a service-level Obsidian vault:

```bash
node src/export-obsidian.mjs /Users/me/workspace/services/.microservice-kg/service-graph.json /Users/me/workspace/services/obsidian-vault
```

## MCP server

The project also exposes the generated graph over MCP so coding agents can query service dependencies while making changes.

Run the server against the default local graph:

```bash
node src/mcp-server.mjs
```

Or point it at a specific graph artifact:

```bash
MICROSERVICE_KG_GRAPH=/path/to/service-graph.json node src/mcp-server.mjs
```

Available MCP tools:

- `analyze_workspace`
- `list_services`
- `service_context`
- `edge_details`
- `dependency_path`
- `service_impact`

For `dependency_path` and `service_impact`, `maxDepth` is optional. If omitted, traversal walks as deep as the currently loaded logical service graph allows.

Example MCP registration:

```bash
codex mcp add microservice-kg -- env MICROSERVICE_KG_GRAPH=/path/to/service-graph.json node /path/to/microservice-kg/src/mcp-server.mjs
```

Example questions an agent can ask through MCP:

- "List all services in this workspace."
- "Show the incoming and outgoing dependencies of a service."
- "Explain the edge between two services with method-level evidence."
- "Find the dependency path from one service to another."
- "Show the downstream impact of changing a service."

## Current scope

- Java/Spring service discovery
- `@RestController` and `@RequestMapping` endpoint extraction
- `@FeignClient` extraction
- config-backed path and URL resolution from `application*.properties|yml|yaml`
- field-based method call inference inside Java classes
- Obsidian export for service-level graph visualization
- MCP server for editor and coding-agent integration

## Current limitations

- HTTP edges currently focus on `@FeignClient`
- `WebClient`, `RestTemplate`, Kafka, gRPC, and async messaging are not fully modeled yet
- service identity normalization is pragmatic, not perfect
- large workspaces may need a future incremental indexer rather than full rescans

## Roadmap

- `WebClient` and `RestTemplate`
- Kafka producers and consumers
- gRPC
- runtime reconciliation with OpenTelemetry service graphs
- graph UI and interactive exploration
