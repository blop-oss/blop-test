import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BlopConfig } from "../runtime/types.js";

const configFiles = ["blop.config.ts", "blop.config.mts", "blop.config.js", "blop.config.mjs"];

export async function loadBlopConfig(cwd = process.cwd(), configPath?: string): Promise<BlopConfig> {
  const file = configPath ? resolve(cwd, configPath) : await findConfigFile(cwd);
  if (!file) return {};

  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  const config = mod.default ?? mod.config ?? {};
  return config satisfies BlopConfig;
}

async function findConfigFile(cwd: string) {
  for (const file of configFiles) {
    const candidate = resolve(cwd, file);
    if (await exists(candidate)) return candidate;
  }

  return null;
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
