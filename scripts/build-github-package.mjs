import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = path.resolve(import.meta.dirname, "..");
const outDir = path.join(rootDir, ".microservice-kg", "github-package");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function inferOwner(pkg) {
  const explicitOwner = process.env.PACKAGE_SCOPE?.trim().replace(/^@/, "");
  if (explicitOwner) {
    return explicitOwner;
  }

  const githubOwner = process.env.GITHUB_REPOSITORY_OWNER?.trim().replace(/^@/, "");
  if (githubOwner) {
    return githubOwner;
  }

  const repoUrl =
    pkg.repository?.url ??
    (typeof pkg.repository === "string" ? pkg.repository : "");
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (match) {
    return match[1];
  }

  throw new Error("Unable to infer package scope owner. Set PACKAGE_SCOPE.");
}

async function copyIntoPackage(relativePath) {
  const sourcePath = path.join(rootDir, relativePath);
  const targetPath = path.join(outDir, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.cp(sourcePath, targetPath, { recursive: true, force: true });
}

async function main() {
  const rootPackage = await readJson(path.join(rootDir, "package.json"));
  const owner = inferOwner(rootPackage);
  const baseName = rootPackage.name.replace(/^@[^/]+\//, "");
  const packageName = `@${owner}/${baseName}`;

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const scopedPackage = {
    ...rootPackage,
    name: packageName,
    repository: rootPackage.repository,
    publishConfig: {
      registry: "https://npm.pkg.github.com",
    },
  };

  if (scopedPackage.scripts) {
    delete scopedPackage.scripts["build:github-package"];
  }

  const readme = `# ${packageName}

Scoped GitHub Packages distribution for [${rootPackage.repository.url.replace(/^git\+/, "").replace(/\.git$/, "")}](${rootPackage.repository.url.replace(/^git\+/, "").replace(/\.git$/, "")}).

- Public npm package: [${baseName}](https://www.npmjs.com/package/${baseName})
- GitHub repository: [${rootPackage.repository.url.replace(/^git\+/, "").replace(/\.git$/, "")}](${rootPackage.repository.url.replace(/^git\+/, "").replace(/\.git$/, "")})

## Install from GitHub Packages

Create an \`.npmrc\` entry for the scope:

\`\`\`
@${owner}:registry=https://npm.pkg.github.com
\`\`\`

Then install:

\`\`\`bash
npm install @${owner}/${baseName}
\`\`\`

This scoped package contains the same CLI and MCP server as the public npm distribution.
`;

  await Promise.all([
    fs.writeFile(path.join(outDir, "package.json"), `${JSON.stringify(scopedPackage, null, 2)}\n`),
    fs.writeFile(path.join(outDir, ".npmrc"), `@${owner}:registry=https://npm.pkg.github.com\n`),
    fs.writeFile(path.join(outDir, "README.md"), readme),
  ]);

  for (const relativePath of [
    "LICENSE",
    "src",
    "docs/images/inter-service-example.png",
    "docs/images/dependency-neighborhood-example.png",
    "docs/images/intra-service-workflow-example.png",
    "docs/images/obsidian-graph-view.png",
  ]) {
    await copyIntoPackage(relativePath);
  }

  process.stdout.write(`${outDir}\n`);
}

await main();
