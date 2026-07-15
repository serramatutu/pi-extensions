import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { type Backend, configHash, type Result } from "../backend.ts";
import type { ConnectionTarget } from "../client.ts";
import { SERVER_PORT, type SandboxConfig } from "../config.ts";
import { generateDockerfile } from "../dockerfile.ts";

const CONFIG_HASH_LABEL = "pi.sandbox.config-hash";
const DOCKERFILE_HASH_LABEL = "pi.sandbox.dockerfile-hash";

const exec = promisify(execFile);

async function docker(args: string[]): Promise<Result> {
  try {
    const { stdout, stderr } = await exec("docker", args, { maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (err: any) {
    return { ok: false, stdout: err?.stdout ?? "", stderr: err?.stderr ?? String(err?.message ?? err) };
  }
}

function dockerBuildFromStdin(image: string, dockerfile: string): Promise<Result> {
  const dfHash = createHash("sha256").update(dockerfile).digest("hex");
  return new Promise((resolve) => {
    // `docker build -` reads the Dockerfile from stdin with an empty build context.
    const args = ["build", "-t", image, "--label", `${DOCKERFILE_HASH_LABEL}=${dfHash}`, "-"];
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ ok: false, stdout, stderr: String(err?.message ?? err) }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
    child.stdin.end(dockerfile);
  });
}

async function available(): Promise<boolean> {
  return (await docker(["--version"])).ok;
}

/** Returns the Dockerfile hash label of the existing image, or null if absent. */
async function imageDockerfileHash(image: string): Promise<string | null> {
  const res = await docker(["image", "inspect", "-f", `{{index .Config.Labels "${DOCKERFILE_HASH_LABEL}"}}`, image]);
  if (!res.ok) return null;
  return res.stdout.trim() || null;
}

/**
 * Builds the image when it is missing or when its baked Dockerfile differs from
 * the one the current config produces (e.g. a stale image from an older build).
 */
async function ensureImage(config: SandboxConfig): Promise<boolean> {
  const dockerfile = generateDockerfile(config);
  const wantHash = createHash("sha256").update(dockerfile).digest("hex");
  if ((await imageDockerfileHash(config.image)) === wantHash) return true;
  return (await dockerBuildFromStdin(config.image, dockerfile)).ok;
}

/** Returns the config hash of a running container, or null if it isn't running. */
async function runningConfigHash(name: string): Promise<string | null> {
  const res = await docker(["inspect", "-f", '{{.State.Running}}|{{index .Config.Labels "' + CONFIG_HASH_LABEL + '"}}', name]);
  if (!res.ok) return null;
  const [running, hash] = res.stdout.trim().split("|");
  if (running !== "true") return null;
  return hash ?? "";
}

async function startContainer(config: SandboxConfig, name: string, cwd: string): Promise<Result> {
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
    // with endpoint() so each session gets its own free port.
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
  let res = await docker(args);
  if (!res.ok && /already in use|already exists/i.test(res.stderr)) {
    await docker(["rm", "-f", name]);
    res = await docker(args);
  }
  return res;
}

async function removeContainer(name: string): Promise<Result> {
  return docker(["rm", "-f", name]);
}

/** Returns the loopback host+port mapped to the container's server port, or null. */
async function endpoint(name: string): Promise<ConnectionTarget | null> {
  const res = await docker(["port", name, `${SERVER_PORT}/tcp`]);
  if (!res.ok) return null;
  // Output looks like "127.0.0.1:49158"; take the last colon-separated field.
  const match = res.stdout
    .trim()
    .split("\n")[0]
    ?.match(/:(\d+)\s*$/);
  return match ? { host: "127.0.0.1", port: Number(match[1]) } : null;
}

export const dockerBackend: Backend = {
  name: "docker",
  available,
  ensureImage,
  runningConfigHash,
  startContainer,
  removeContainer,
  endpoint,
};
