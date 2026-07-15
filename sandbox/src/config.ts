import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
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

const CWD_CONFIG = "pi-sandbox.yaml";
const GLOBAL_CONFIG = join(homedir(), ".pi", "agent", "pi-sandbox.yaml");

async function readYaml(path: string): Promise<unknown | null> {
  try {
    return parse(await readFile(path, "utf8"));
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
 * Loads pi-sandbox.yaml from cwd, falling back to ~/.pi/agent/pi-sandbox.yaml.
 * When neither exists, schema defaults are used.
 */
export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const candidates = [join(cwd, CWD_CONFIG), GLOBAL_CONFIG];

  for (const path of candidates) {
    const raw = await readYaml(path);
    if (raw === null) continue;
    return { config: configSchema.parse(raw), source: path };
  }

  return { config: configSchema.parse({}), source: null };
}

/**
 * Loads the config file, applies a mutation to its raw contents, and writes it
 * back. Writes to the config that was loaded (cwd or global), or creates
 * cwd/pi-sandbox.yaml. Returns the path written.
 */
async function updateConfig(cwd: string, mutate: (raw: Record<string, unknown>) => void): Promise<string> {
  const { source } = await loadConfig(cwd);
  const path = source ?? join(cwd, CWD_CONFIG);

  const raw = ((await readYaml(path)) ?? {}) as Record<string, unknown>;
  mutate(raw);

  await writeFile(path, stringify(raw), "utf8");
  return path;
}

/** Adds a mount to the config. No-ops when an identical mount already exists. */
export function addMount(cwd: string, mount: SandboxMount): Promise<string> {
  return updateConfig(cwd, (raw) => {
    const mounts = Array.isArray(raw.mounts) ? (raw.mounts as SandboxMount[]) : [];
    const exists = mounts.some((m) => m.source === mount.source && m.target === mount.target);
    if (!exists) mounts.push(mount);
    raw.mounts = mounts;
  });
}

/** Sets an env var value in the config "env" map. */
export function addEnv(cwd: string, name: string, value: string): Promise<string> {
  return updateConfig(cwd, (raw) => {
    const env = (raw.env && typeof raw.env === "object" ? raw.env : {}) as Record<string, string>;
    env[name] = value;
    raw.env = env;
  });
}

/** Adds an env var name to the config "envForward" list. No-ops when already forwarded. */
export function addEnvForward(cwd: string, name: string): Promise<string> {
  return updateConfig(cwd, (raw) => {
    const forward = Array.isArray(raw.envForward) ? (raw.envForward as string[]) : [];
    if (!forward.includes(name)) forward.push(name);
    raw.envForward = forward;
  });
}
