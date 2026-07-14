import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** Port the sandbox server listens on inside the container. */
export const SERVER_PORT = 7070;

const DEFAULT_TOOLS = [
  "bash",
  "coreutils",
  "findutils",
  "sed",
  "gawk",
  "jq",
  "yq",
  "ripgrep",
  "fd",
  "git",
  "curl",
  "ca-certificates",
];

const mountSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  readonly: z.boolean().default(false),
});

const configSchema = z.object({
  image: z.string().min(1).default("pi-coding-sandbox"),
  baseImage: z.string().min(1).default("alpine:latest"),
  tools: z.array(z.string().min(1)).default(DEFAULT_TOOLS),
  workdir: z.string().min(1).default("/workspace"),
  namePrefix: z.string().min(1).default("pi-sandbox-"),
  mountCwd: z.boolean().default(true),
  mounts: z.array(mountSchema).default([]),
  env: z.record(z.string(), z.string()).default({}),
  envForward: z.array(z.string().min(1)).default([]),
});

export type SandboxMount = z.infer<typeof mountSchema>;

export type SandboxConfig = z.infer<typeof configSchema>;

const CWD_CONFIG = "sandbox.json";
const GLOBAL_CONFIG = join(homedir(), ".pi", "agent", "sandbox.json");

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export interface LoadedConfig {
  config: SandboxConfig;
  source: string | null;
}

/**
 * Loads sandbox.json from cwd, falling back to ~/.pi/agent/sandbox.json.
 * When neither exists, schema defaults are used.
 */
export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const candidates = [join(cwd, CWD_CONFIG), GLOBAL_CONFIG];

  for (const path of candidates) {
    const raw = await readJson(path);
    if (raw === null) continue;
    return { config: configSchema.parse(raw), source: path };
  }

  return { config: configSchema.parse({}), source: null };
}
