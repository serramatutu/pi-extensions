import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { generateDockerfile } from "../src/dockerfile.ts";

async function defaultConfig() {
  const { config } = await loadConfig("/nonexistent-dir");
  return config;
}

test("uses the configured base image", async () => {
  const config = await defaultConfig();
  config.baseImage = "alpine:3.20";
  assert.match(generateDockerfile(config), /^FROM alpine:3\.20$/m);
});

test("installs configured tools and required server packages", async () => {
  const config = await defaultConfig();
  config.tools = ["git", "curl"];
  const df = generateDockerfile(config);

  assert.match(df, /apk add --no-cache/);
  for (const pkg of ["git", "curl", "socat", "jq", "coreutils"]) {
    assert.match(df, new RegExp(`\\n\\s+${pkg}(\\s|$)`, "m"), `expected package ${pkg}`);
  }
});

test("deduplicates packages when tools overlap server requirements", async () => {
  const config = await defaultConfig();
  config.tools = ["jq", "socat", "git"];
  const df = generateDockerfile(config);

  assert.equal(df.match(/\n\s+jq(\s|$)/gm)?.length, 1);
  assert.equal(df.match(/\n\s+socat(\s|$)/gm)?.length, 1);
});

test("adds fdfind alias only when fd is installed", async () => {
  const config = await defaultConfig();
  config.tools = ["fd"];
  assert.match(generateDockerfile(config), /ln -s .* \/usr\/local\/bin\/fdfind/);

  config.tools = ["git"];
  assert.doesNotMatch(generateDockerfile(config), /fdfind/);
});

test("exposes and serves on the internal server port", async () => {
  const config = await defaultConfig();
  const df = generateDockerfile(config);
  assert.match(df, /EXPOSE 7070/);
  assert.match(df, /CMD \["socat", "TCP-LISTEN:7070,reuseaddr,fork", "EXEC:\/usr\/local\/bin\/sandbox-handler"\]/);
});

test("bakes the handler script as a decodable base64 blob", async () => {
  const config = await defaultConfig();
  const df = generateDockerfile(config);
  const match = df.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d > \/usr\/local\/bin\/sandbox-handler/);
  assert.ok(match, "expected base64 handler install line");

  const script = Buffer.from(match![1], "base64").toString("utf8");
  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /read\)/);
  assert.match(script, /write\)/);
  assert.match(script, /unknown command/);
});

test("sets the workdir from config", async () => {
  const config = await defaultConfig();
  config.workdir = "/srv/app";
  assert.match(generateDockerfile(config), /^WORKDIR \/srv\/app$/m);
});
