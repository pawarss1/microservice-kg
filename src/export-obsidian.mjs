#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

async function main() {
  const [, , inputGraphPath, outputVaultPath] = process.argv;
  if (!inputGraphPath || !outputVaultPath) {
    console.error("Usage: node export-obsidian.mjs <service-graph.json> <output-vault>");
    process.exit(1);
  }

  const graph = JSON.parse(await fs.readFile(path.resolve(inputGraphPath), "utf8"));
  const vaultPath = path.resolve(outputVaultPath);
  const servicesDir = path.join(vaultPath, "services");
  const obsidianDir = path.join(vaultPath, ".obsidian");

  await fs.rm(vaultPath, { recursive: true, force: true });
  await fs.mkdir(servicesDir, { recursive: true });
  await fs.mkdir(obsidianDir, { recursive: true });

  const serviceMap = new Map();
  for (const service of graph.services) {
    if (!serviceMap.has(service.id)) {
      serviceMap.set(service.id, {
        id: service.id,
        roots: new Set(),
        endpointCount: 0,
        clientCount: 0,
        methodInteractionCount: 0,
      });
    }
    const entry = serviceMap.get(service.id);
    entry.roots.add(service.relativeRootDir || service.rootDir || service.id);
    entry.endpointCount += service.endpoints?.length || 0;
    entry.clientCount += service.clients?.length || 0;
    entry.methodInteractionCount += service.methodInteractions?.length || 0;
  }

  const outgoingMap = new Map();
  const incomingMap = new Map();
  for (const edge of graph.serviceEdges) {
    if (!outgoingMap.has(edge.sourceServiceId)) {
      outgoingMap.set(edge.sourceServiceId, []);
    }
    outgoingMap.get(edge.sourceServiceId).push(edge);

    if (!incomingMap.has(edge.targetServiceId)) {
      incomingMap.set(edge.targetServiceId, []);
    }
    incomingMap.get(edge.targetServiceId).push(edge);
  }

  const notePathByServiceId = new Map();
  for (const serviceId of Array.from(serviceMap.keys()).sort((a, b) => a.localeCompare(b))) {
    notePathByServiceId.set(serviceId, `services/${serviceId}.md`);
  }

  const serviceIds = Array.from(serviceMap.keys()).sort((a, b) => a.localeCompare(b));
  for (const serviceId of serviceIds) {
    const entry = serviceMap.get(serviceId);
    const outgoing = (outgoingMap.get(serviceId) || []).sort((a, b) => a.targetServiceId.localeCompare(b.targetServiceId));
    const incoming = (incomingMap.get(serviceId) || []).sort((a, b) => a.sourceServiceId.localeCompare(b.sourceServiceId));
    const lines = [
      `# ${serviceId}`,
      "",
      "## Service",
      "",
      `- Logical service id: \`${serviceId}\``,
      `- Roots: ${Array.from(entry.roots).sort((a, b) => a.localeCompare(b)).map((root) => `\`${root}\``).join(", ")}`,
      `- Endpoints discovered: ${entry.endpointCount}`,
      `- Clients discovered: ${entry.clientCount}`,
      `- Method interactions discovered: ${entry.methodInteractionCount}`,
      "",
      "## Outgoing",
      "",
    ];

    if (outgoing.length === 0) {
      lines.push("- None", "");
    } else {
      for (const edge of outgoing) {
        const targetLink = linkToService(edge.targetServiceId, notePathByServiceId);
        lines.push(`- ${targetLink}`);
        for (const call of edge.calls.slice(0, 8)) {
          lines.push(`  - \`${call.httpMethod}\` \`${call.path}\``);
          lines.push(`  - client: \`${call.sourceClassName}.${call.sourceMethodName}\``);
          if (call.provider) {
            lines.push(`  - provider: \`${call.provider.targetClassName}.${call.provider.targetMethodName}\``);
          }
        }
      }
      lines.push("");
    }

    lines.push("## Incoming", "");
    if (incoming.length === 0) {
      lines.push("- None", "");
    } else {
      for (const edge of incoming) {
        lines.push(`- ${linkToService(edge.sourceServiceId, notePathByServiceId)}`);
      }
      lines.push("");
    }

    lines.push("## Notes", "", "- Graph view shows logical service-to-service links from these markdown references.");

    await fs.writeFile(
      path.join(vaultPath, notePathByServiceId.get(serviceId)),
      `${lines.join("\n")}\n`,
      "utf8",
    );
  }

  const indexLines = [
    "# Microservice KG",
    "",
    `- Generated at: ${graph.generatedAt}`,
    `- Input directory: \`${graph.inputDir}\``,
    `- Logical services: ${serviceIds.length}`,
    `- Service edges: ${graph.serviceEdges.length}`,
    "",
    "## Services",
    "",
    ...serviceIds.map((serviceId) => `- ${linkToService(serviceId, notePathByServiceId)}`),
  ];

  await fs.writeFile(path.join(vaultPath, "INDEX.md"), `${indexLines.join("\n")}\n`, "utf8");

  const corePlugins = [
    "file-explorer",
    "graph",
    "markdown-importer",
    "outline",
    "search",
    "switcher",
  ];

  await fs.writeFile(
    path.join(obsidianDir, "core-plugins.json"),
    `${JSON.stringify(corePlugins, null, 2)}\n`,
    "utf8",
  );

  await fs.writeFile(
    path.join(obsidianDir, "graph.json"),
    `${JSON.stringify({
      "collapse-filter": false,
      search: "",
      showTags: false,
      showAttachments: false,
      showExistingOnly: true,
      localJumps: false,
      colorGroups: [],
    }, null, 2)}\n`,
    "utf8",
  );

  await fs.writeFile(
    path.join(obsidianDir, "workspace.json"),
    `${JSON.stringify({
      main: {
        id: "main",
        type: "split",
        children: [
          {
            id: "graph-leaf",
            type: "leaf",
            state: {
              type: "graph",
              state: {},
            },
          },
        ],
        direction: "vertical",
      },
      left: {
        id: "left",
        type: "split",
        children: [
          {
            id: "left-tabs",
            type: "tabs",
            children: [
              {
                id: "file-explorer",
                type: "leaf",
                state: {
                  type: "file-explorer",
                  state: {},
                },
              },
            ],
          },
        ],
        direction: "horizontal",
        width: 300,
      },
      right: {
        id: "right",
        type: "split",
        children: [],
        direction: "horizontal",
        width: 300,
      },
      active: "graph-leaf",
      lastOpenFiles: ["INDEX.md"],
    }, null, 2)}\n`,
    "utf8",
  );

  console.log(`Created Obsidian vault at ${vaultPath}`);
  console.log(`Logical services: ${serviceIds.length}`);
  console.log(`Service edges: ${graph.serviceEdges.length}`);
}

function linkToService(serviceId, notePathByServiceId) {
  const notePath = notePathByServiceId.get(serviceId);
  const basename = path.basename(notePath, ".md");
  return `[[${basename}]]`;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
