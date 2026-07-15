import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type Backend, configHash, type Result } from "../backend.ts";
import type { ConnectionTarget } from "../client.ts";
import { SERVER_PORT, type SandboxConfig } from "../config.ts";
import { generateDockerfile } from "../dockerfile.ts";

const exec = promisify(execFile);

/**
 * Apple's `container` CLI does not expose Docker-style label queries, so image
 * and container hashes are tracked in this local state file instead. Entries
 * are validated against `container inspect`/`images inspect` before being
 * trusted, so a stale file only ever forces an unnecessary rebuild or restart.
 */
const STATE_FILE = join(homedir(), ".pi", "agent", "sandbox-container-state.json");

interface State {
  /** image tag -> Dockerfile hash it was built from. */
  images: Record<string, string>;
  /** container name -> config hash it was started with. */
  containers: Record<string, string>;
}

async function readState(): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8"));
    return { images: parsed?.images ?? {}, containers: parsed?.containers ?? {} };
  } catch {
    return { images: {}, containers: {} };
  }
}

async function writeState(state: State): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state), "utf8");
}

async function container(args: string[]): Promise<Result> {
  try {
    const { stdout, stderr } = await exec("container", args, { maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (err: any) {
    return { ok: false, stdout: err?.stdout ?? "", stderr: err?.stderr ?? String(err?.message ?? err) };
  }
}

async function available(): Promise<boolean> {
  return (await container(["--version"])).ok;
}

/** Runs `container inspect` and returns the first parsed object, or null. */
async function inspect(target: string): Promise<any | null> {
  const res = await container(["inspect", target]);
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed) ? (parsed[0] ?? null) : parsed;
  } catch {
    return null;
  }
}

function isRunning(info: any): boolean {
  const state = info?.status?.state ?? info?.status ?? info?.state ?? "";
  return String(state).toLowerCase() === "running";
}

/** Pulls an IPv4 address out of a container's network list, if present. */
function extractAddress(info: any): string | null {
  const networks = info?.status?.networks ?? info?.networks;
  const list = Array.isArray(networks) ? networks : networks ? Object.values(networks) : [];
  for (const net of list as any[]) {
    const addr = net?.ipv4Address ?? net?.address ?? net?.ipAddress ?? net?.ip;
    if (typeof addr === "string") {
      const ip = addr.split("/")[0].trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    }
  }
  return null;
}

async function imageExists(image: string): Promise<boolean> {
  return (await container(["images", "inspect", image])).ok;
}

/**
 * Builds the image when it is missing or when the Dockerfile the current config
 * produces differs from the one recorded for the existing image. `container
 * build` needs a context directory, so the Dockerfile is written to a temp dir.
 */
async function ensureImage(config: SandboxConfig): Promise<boolean> {
  const dockerfile = generateDockerfile(config);
  const wantHash = createHash("sha256").update(dockerfile).digest("hex");

  const state = await readState();
  if (state.images[config.image] === wantHash && (await imageExists(config.image))) return true;

  const context = await mkdtemp(join(tmpdir(), "pi-sandbox-build-"));
  try {
    const dockerfilePath = join(context, "Dockerfile");
    await writeFile(dockerfilePath, dockerfile, "utf8");
    const res = await container(["build", "--tag", config.image, "--file", dockerfilePath, context]);
    if (!res.ok) return false;
  } finally {
    await rm(context, { recursive: true, force: true });
  }

  state.images[config.image] = wantHash;
  await writeState(state);
  return true;
}

/** Returns the config hash of a running container, or null if it isn't running. */
async function runningConfigHash(name: string): Promise<string | null> {
  const info = await inspect(name);
  if (!info || !isRunning(info)) return null;
  return (await readState()).containers[name] ?? "";
}

async function startContainer(config: SandboxConfig, name: string, cwd: string): Promise<Result> {
  // Remove any stale container with the same name, then start fresh.
  await container(["delete", "--force", name]);

  // No `-p` mapping: `container` gives each container its own IP, resolved by
  // endpoint() below. The server is reached directly on SERVER_PORT.
  const args = ["run", "-d", "--name", name, "-w", config.workdir];

  if (config.mountCwd) {
    args.push("-v", `${cwd}:${config.workdir}`);
  }
  for (const mount of config.mounts) {
    args.push("-v", `${mount.source}:${mount.target}${mount.readonly ? ":ro" : ""}`);
  }
  for (const key of config.envForward) {
    if (process.env[key] !== undefined) {
      args.push("-e", `${key}=${process.env[key]}`);
    }
  }
  for (const [key, value] of Object.entries(config.env)) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(config.image);

  const res = await container(args);
  if (res.ok) {
    const state = await readState();
    state.containers[name] = configHash(config);
    await writeState(state);
  }
  return res;
}

async function removeContainer(name: string): Promise<Result> {
  const res = await container(["delete", "--force", name]);
  const state = await readState();
  if (state.containers[name] !== undefined) {
    delete state.containers[name];
    await writeState(state);
  }
  return res;
}

/** Returns the container's own IP and the server port, or null if unresolved. */
async function endpoint(name: string): Promise<ConnectionTarget | null> {
  const info = await inspect(name);
  if (!info || !isRunning(info)) return null;
  const host = extractAddress(info);
  return host ? { host, port: SERVER_PORT } : null;
}

export const appleBackend: Backend = {
  name: "container",
  available,
  ensureImage,
  runningConfigHash,
  startContainer,
  removeContainer,
  endpoint,
};
