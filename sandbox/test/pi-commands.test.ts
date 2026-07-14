import assert from "node:assert/strict";
import { test } from "node:test";
import { toContainerPath } from "../src/pi-commands.ts";

const cwd = "/home/user/project";
const workdir = "/workspace";

test("maps a relative path into the container workdir", () => {
  assert.equal(toContainerPath(cwd, workdir, "src/app.ts"), "/workspace/src/app.ts");
});

test("maps a host path inside cwd into the workdir", () => {
  assert.equal(toContainerPath(cwd, workdir, "/home/user/project/lib/x.ts"), "/workspace/lib/x.ts");
});

test("maps cwd itself to the workdir root", () => {
  assert.equal(toContainerPath(cwd, workdir, "."), "/workspace");
});

test("strips a leading @ before mapping", () => {
  assert.equal(toContainerPath(cwd, workdir, "@src/app.ts"), "/workspace/src/app.ts");
});

test("resolves paths outside cwd to their absolute host path", () => {
  assert.equal(toContainerPath(cwd, workdir, "/etc/hosts"), "/etc/hosts");
  assert.equal(toContainerPath(cwd, workdir, "../other/file.ts"), "/home/user/other/file.ts");
});
