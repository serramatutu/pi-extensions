import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { type ConnectionTarget, exec as sandboxExec, read, SandboxError, write } from "../src/client.ts";
import { containerName } from "../src/backend.ts";
import { dockerBackend } from "../src/backends/docker.ts";
import { loadConfig, type SandboxConfig } from "../src/config.ts";

const exec = promisify(execFile);
const hasDocker = await dockerBackend.available();
const skip = hasDocker ? false : "docker not available";

let config: SandboxConfig;
let name: string;
let target: ConnectionTarget;
let workdir: string;

before(
  async () => {
    if (!hasDocker) return;
    workdir = await mkdtemp(join(tmpdir(), "sandbox-e2e-"));
    await writeFile(join(workdir, "hello.txt"), "hello from e2e\n");

    ({ config } = await loadConfig("/nonexistent-dir"));
    config.image = "pi-sandbox-e2e-test";
    config.namePrefix = "pi-sandbox-e2e-";

    assert(await dockerBackend.ensureImage(config), "image build failed");

    name = containerName(config, "e2e-session");
    const run = await dockerBackend.startContainer(config, name, workdir);
    assert(run.ok, `container start failed: ${run.stderr}`);

    // Wait for socat to bind and the endpoint to become resolvable.
    for (let i = 0; i < 50; i++) {
      const t = await dockerBackend.endpoint(name);
      if (t) {
        target = t;
        break;
      }
      await sleep(100);
    }
    assert(target, "server endpoint never became available");
  },
  { timeout: 180_000 },
);

after(async () => {
  if (name) await dockerBackend.removeContainer(name);
  if (config?.image) await exec("docker", ["rmi", "-f", config.image]).catch(() => {});
  if (workdir) await rm(workdir, { recursive: true, force: true });
});

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

test("reads a mounted file over TCP", { skip }, async () => {
  const content = await read(target, `${config.workdir}/hello.txt`);
  assert(content === "hello from e2e\n", `unexpected content: ${JSON.stringify(content)}`);
});

test("reads a file created inside the container", { skip }, async () => {
  await exec("docker", ["exec", name, "sh", "-c", "echo written-inside > /tmp/inside.txt"]);
  const content = await read(target, "/tmp/inside.txt");
  assert(content === "written-inside\n", `unexpected content: ${JSON.stringify(content)}`);
});

test("writes a file to a mounted directory and reads it back", { skip }, async () => {
  await write(target, `${config.workdir}/out.txt`, "written via tcp\n");
  const content = await read(target, `${config.workdir}/out.txt`);
  assert(content === "written via tcp\n", `unexpected content: ${JSON.stringify(content)}`);
});

test("creates parent directories when writing", { skip }, async () => {
  await write(target, `${config.workdir}/nested/deep/file.txt`, "nested\n");
  const content = await read(target, `${config.workdir}/nested/deep/file.txt`);
  assert(content === "nested\n", `unexpected content: ${JSON.stringify(content)}`);
});

test("executes a command and captures stdout and exit code", { skip }, async () => {
  const res = await sandboxExec(target, "echo hello && echo oops >&2");
  assert(res.exitCode === 0, `unexpected exit code: ${res.exitCode}`);
  assert(res.stdout === "hello\n", `unexpected stdout: ${JSON.stringify(res.stdout)}`);
  assert(res.stderr === "oops\n", `unexpected stderr: ${JSON.stringify(res.stderr)}`);
});

test("reports a non-zero exit code", { skip }, async () => {
  const res = await sandboxExec(target, "exit 3");
  assert(res.exitCode === 3, `unexpected exit code: ${res.exitCode}`);
});

test("runs commands in the mounted workdir", { skip }, async () => {
  const res = await sandboxExec(target, "cat hello.txt");
  assert(res.stdout === "hello from e2e\n", `unexpected stdout: ${JSON.stringify(res.stdout)}`);
});

test("rejects reading a missing file with a not_found status", { skip }, async () => {
  try {
    await read(target, "/tmp/does-not-exist");
  } catch (err: any) {
    assert(err instanceof SandboxError, `expected SandboxError, got ${err}`);
    assert(err.status === "not_found", `expected not_found status, got ${err.status}`);
    return;
  }
  throw new Error("expected rejection");
});
