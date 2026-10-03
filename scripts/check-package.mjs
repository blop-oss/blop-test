#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packs = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }),
);
assert.equal(packs.length, 1, "Expected one standalone npm package");
const pack = packs[0];
assert.equal(pack.name, "@blopai/test");
assert.equal(pack.version, pkg.version);
assert.equal(pkg.bin, undefined, "The blop CLI belongs to @blopai/cli");
assert.equal(
  pkg.repository.url,
  "git+https://github.com/blop-oss/blop-test.git",
);
assert.equal(
  pkg.repository.directory,
  undefined,
  "No monorepo directory metadata",
);

const packed = new Set(pack.files.map((file) => file.path));
for (const file of [
  "package.json",
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "PRIVACY.md",
  "SECURITY.md",
  "RELEASING.md",
  "LICENSE",
  "templates/basic.blop.ts",
]) {
  assert(packed.has(file), `Required package file missing: ${file}`);
}
for (const file of packed) {
  assert(
    /^(?:dist\/|templates\/|(?:package\.json|README\.md|AGENTS\.md|CONTRIBUTING\.md|PRIVACY\.md|SECURITY\.md|RELEASING\.md|LICENSE)$)/.test(
      file,
    ),
    `Unexpected package file: ${file}`,
  );
  assert(
    !/(?:^|\/)(?:\.env(?:\.|$)|node_modules|\.blop|\.git)(?:\/|$)/.test(file),
  );
}
for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
  for (const [name, version] of Object.entries(pkg[section] ?? {})) {
    assert(
      !/^(?:workspace:|file:|link:)/.test(version),
      `Non-standalone ${section} entry: ${name}=${version}`,
    );
  }
}

function assertExportTarget(target) {
  if (typeof target === "string") {
    assert(target.startsWith("./"), `Invalid package export: ${target}`);
    const file = target.slice(2);
    if (file.includes("*")) {
      const [prefix, suffix] = file.split("*");
      assert(
        [...packed].some(
          (item) => item.startsWith(prefix) && item.endsWith(suffix),
        ),
        `Wildcard export matches no package files: ${target}`,
      );
    } else {
      assert(packed.has(file), `Package export missing: ${target}`);
    }
  } else {
    for (const child of Object.values(target)) assertExportTarget(child);
  }
}
for (const target of Object.values(pkg.exports)) assertExportTarget(target);

for (const file of collectSourceFiles(join(root, "src"))) {
  const stem = relative(join(root, "src"), file).replace(/\.ts$/, "");
  for (const extension of [".js", ".d.ts", ".js.map"]) {
    assert(
      packed.has(`dist/${stem}${extension}`),
      `Missing build output: ${stem}${extension}`,
    );
  }
}
for (const file of packed) {
  if (file.startsWith("dist/") && file.endsWith(".js")) {
    assert(
      packed.has(file.replace(/\.js$/, ".d.ts")),
      `Missing declarations: ${file}`,
    );
  }
}
process.stdout.write(
  `Verified ${pack.name}@${pack.version}: ${packed.size} package files and every public export.\n`,
);

function collectSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}
