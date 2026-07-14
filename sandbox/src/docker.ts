import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { SERVER_PORT, type SandboxConfig } from "./config.ts";
import { generateDockerfile } from "./dockerfile.ts";

const CONFIG_HASH_LABEL = "pi.sandbox.config-hash";

export function configHash(config: SandboxConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

const exec = promisify(execFile);

interface Result {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function docker(args: string[]): Promise<Result> {
  try {
    const { stdout, stderr } = await exec("docker", args, { maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (err: any) {
    return { ok: false, stdout: err?.stdout ?? "", stderr: err?.stderr ?? String(err?.message ?? err) };
  }
}

function dockerBuildFromStdin(image: string, dockerfile: string): Promise<Result> {
  return new Promise((resolve) => {
    // `docker build -` reads the Dockerfile from stdin with an empty build context.
    const child = spawn("docker", ["build", "-t", image, "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ ok: false, stdout, stderr: String(err?.message ?? err) }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
    child.stdin.end(dockerfile);
  });
}

export function containerName(config: SandboxConfig, sessionId: string): string {
  return config.namePrefix + sessionId.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export async function available(): Promise<boolean> {
  return (await docker(["--version"])).ok;
}

async function imageExists(config: SandboxConfig): Promise<boolean> {
  return (await docker(["image", "inspect", config.image])).ok;
}

export async function ensureImage(config: SandboxConfig, rebuild = false): Promise<boolean> {
  if (!rebuild && (await imageExists(config))) return true;
  return (await dockerBuildFromStdin(config.image, generateDockerfile(config))).ok;
}

/** Returns the config hash of a running container, or null if it isn't running. */
export async function runningConfigHash(name: string): Promise<string | null> {
  const res = await docker(["inspect", "-f", "{{.State.Running}}|{{index .Config.Labels \"" + CONFIG_HASH_LABEL + "\"}}", name]);
  if (!res.ok) return null;
  const [running, hash] = res.stdout.trim().split("|");
  if (running !== "true") return null;
  return hash ?? "";
}

export async function startContainer(config: SandboxConfig, name: string, cwd: string): Promise<Result> {
  // Remove any stale container with the same name, then start fresh.
  await docker(["rm", "-f", name]);

  const args = [
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `${CONFIG_HASH_LABEL}=${configHash(config)}`,
    "-w",
    config.workdir,
    // Bind to a host-assigned ephemeral port on loopback; resolve it later
    // with getPublishedPort so each session gets its own free port.
    "-p",
    `127.0.0.1::${SERVER_PORT}`,
  ];

  if (config.mountCwd) {
    args.push("-v", `${cwd}:${config.workdir}`);
  }
  for (const mount of config.mounts) {
    args.push("-v", `${mount.source}:${mount.target}${mount.readonly ? ":ro" : ""}`);
  }
  for (const name of config.envForward) {
    if (process.env[name] !== undefined) {
      args.push("-e", `${name}=${process.env[name]}`);
    }
  }
  for (const [key, value] of Object.entries(config.env)) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(config.image);
  return docker(args);
}

export async function removeContainer(name: string): Promise<Result> {
  return docker(["rm", "-f", name]);
}

/** Returns the host port mapped to the container's server port, or null. */
export async function getPublishedPort(name: string): Promise<number | null> {
  const res = await docker(["port", name, `${SERVER_PORT}/tcp`]);
  if (!res.ok) return null;
  // Output looks like "127.0.0.1:49158"; take the last colon-separated field.
  const match = res.stdout.trim().split("\n")[0]?.match(/:(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}
