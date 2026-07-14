import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { read } from "../src/client.ts";
import { loadConfig, type SandboxConfig } from "../src/config.ts";
import {
  available,
  containerName,
  ensureImage,
  getPublishedPort,
  removeContainer,
  startContainer,
} from "../src/docker.ts";

const exec = promisify(execFile);
const hasDocker = await available();
const skip = hasDocker ? false : "docker not available";

let config: SandboxConfig;
let name: string;
let port: number;
let workdir: string;

before(
  async () => {
    if (!hasDocker) return;
    workdir = await mkdtemp(join(tmpdir(), "sandbox-e2e-"));
    await writeFile(join(workdir, "hello.txt"), "hello from e2e\n");

    ({ config } = await loadConfig("/nonexistent-dir"));
    config.image = "pi-sandbox-e2e-test";
    config.namePrefix = "pi-sandbox-e2e-";

    assert(await ensureImage(config), "image build failed");

    name = containerName(config, "e2e-session");
    const run = await startContainer(config, name, workdir);
    assert(run.ok, `container start failed: ${run.stderr}`);

    // Wait for socat to bind and the port mapping to appear.
    for (let i = 0; i < 50; i++) {
      const p = await getPublishedPort(name);
      if (p) {
        port = p;
        break;
      }
      await sleep(100);
    }
    assert(port, "server port never became available");
  },
  { timeout: 180_000 },
);

after(async () => {
  if (name) await removeContainer(name);
  if (config?.image) await exec("docker", ["rmi", "-f", config.image]).catch(() => {});
  if (workdir) await rm(workdir, { recursive: true, force: true });
});

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

test("reads a mounted file over TCP", { skip }, async () => {
  const content = await read(port, `${config.workdir}/hello.txt`);
  assert(content === "hello from e2e\n", `unexpected content: ${JSON.stringify(content)}`);
});

test("reads a file created inside the container", { skip }, async () => {
  await exec("docker", ["exec", name, "sh", "-c", "echo written-inside > /tmp/inside.txt"]);
  const content = await read(port, "/tmp/inside.txt");
  assert(content === "written-inside\n", `unexpected content: ${JSON.stringify(content)}`);
});

test("rejects reading a missing file", { skip }, async () => {
  await assertRejects(() => read(port, "/tmp/does-not-exist"), /no such file/);
});

async function assertRejects(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await fn();
  } catch (err: any) {
    assert(pattern.test(String(err?.message ?? err)), `error did not match ${pattern}: ${err}`);
    return;
  }
  throw new Error("expected rejection");
}
