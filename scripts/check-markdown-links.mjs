#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ignoredDirectories = new Set(["dist", "node_modules"]);
const markdownFiles = collectMarkdownFiles(root);
const failures = [];

for (const file of markdownFiles) {
  const source = readFileSync(file, "utf8");
  const destinations = [
    ...source.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g),
    ...source.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm),
    ...source.matchAll(/<(?:img|source)\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi),
  ].map((match) => match[1].replace(/^<|>$/g, ""));

  for (const destination of destinations) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(destination)) continue;
    try {
      const path = decodeURIComponent(destination.split(/[?#]/, 1)[0]);
      if (!path) continue;
      const target = path.startsWith("/")
        ? resolve(root, `.${path}`)
        : resolve(dirname(file), path);
      const local = relative(root, target);
      if (local === ".." || local.startsWith(`..${sep}`)) {
        failures.push(
          `${relative(root, file)}: outside repository: ${destination}`,
        );
      } else if (!existsSync(target)) {
        failures.push(`${relative(root, file)}: missing file: ${destination}`);
      }
    } catch (error) {
      failures.push(
        `${relative(root, file)}: ${destination}: ${error.message}`,
      );
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Broken local documentation links:\n${failures.join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Checked local file links in ${markdownFiles.length} Markdown files (not remote URLs or heading anchors).\n`,
  );
}

function collectMarkdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") && entry.name !== ".github") return [];
    if (ignoredDirectories.has(entry.name)) return [];
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectMarkdownFiles(path);
    return entry.isFile() && /\.mdx?$/.test(entry.name) ? [path] : [];
  });
}
