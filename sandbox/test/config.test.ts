import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { addMount, loadConfig } from "../src/config.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sandbox-cfg-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("creates sandbox.json with the mount when none exists", async () => {
  const path = await addMount(dir, { source: "/host/f", target: "/host/f", readonly: true });
  assert.equal(path, join(dir, "sandbox.json"));

  const { config } = await loadConfig(dir);
  assert.deepEqual(config.mounts, [{ source: "/host/f", target: "/host/f", readonly: true }]);
});

test("appends to an existing config without dropping other fields", async () => {
  await writeFile(join(dir, "sandbox.json"), JSON.stringify({ image: "custom", mounts: [] }));
  await addMount(dir, { source: "/a", target: "/a", readonly: true });

  const { config } = await loadConfig(dir);
  assert.equal(config.image, "custom");
  assert.equal(config.mounts.length, 1);
});

test("does not duplicate an identical mount", async () => {
  const mount = { source: "/a", target: "/a", readonly: true };
  await addMount(dir, mount);
  await addMount(dir, mount);

  const { config } = await loadConfig(dir);
  assert.equal(config.mounts.length, 1);
});
