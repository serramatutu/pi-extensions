import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.ts";
import {
  available,
  configHash,
  containerName,
  ensureImage,
  getPublishedPort,
  removeContainer,
  runningConfigHash,
  startContainer as dockerStart,
} from "./docker.ts";

export interface Sandbox {
  name: string;
  port: number;
  /** Container path that the session cwd is mounted at. */
  workdir: string;
}

let current: Sandbox | null = null;

/** Handle for the running sandbox, or null when no container is up. */
export function sandbox(): Sandbox | null {
  return current;
}

/**
 * Ensures a sandbox container is running for this session. Rebuilds the image
 * and restarts the container when the config has changed; no-ops when the
 * running container already matches the current config.
 */
export async function startContainer(ctx: ExtensionContext): Promise<void> {
  if (!(await available())) {
    ctx.ui.notify("sandbox: docker not found; skipping container startup", "warning");
    return;
  }

  let config;
  try {
    ({ config } = await loadConfig(ctx.cwd));
  } catch (err: any) {
    ctx.ui.notify(`sandbox: invalid config: ${err?.message ?? err}`, "error");
    return;
  }

  const name = containerName(config, ctx.sessionManager.getSessionId());
  const hash = configHash(config);
  const running = await runningConfigHash(name);

  // Reuse the running container only when it matches the config AND still
  // exposes a reachable port. Otherwise fall through and (re)start it.
  if (running === hash) {
    await track(name, config.workdir);
    if (current) {
      ctx.ui.setStatus("sandbox", `container ${name} up on :${current.port}`);
      return;
    }
  }

  const changed = running !== null;
  ctx.ui.setStatus("sandbox", changed ? "config changed; restarting container…" : "starting container…");

  if (!(await ensureImage(config))) {
    ctx.ui.setStatus("sandbox", "");
    ctx.ui.notify(`sandbox: failed to build image ${config.image}`, "error");
    return;
  }

  const run = await dockerStart(config, name, ctx.cwd);
  if (!run.ok) {
    ctx.ui.setStatus("sandbox", "");
    ctx.ui.notify(`sandbox: failed to start container: ${run.stderr.trim()}`, "error");
    return;
  }

  await track(name, config.workdir);
  if (!current) {
    ctx.ui.setStatus("sandbox", "");
    ctx.ui.notify(`sandbox: container ${name} started but no port could be resolved`, "error");
    return;
  }
  ctx.ui.setStatus("sandbox", `container ${name} up on :${current.port}`);
  ctx.ui.notify(`sandbox: container ${name} ${changed ? "restarted" : "started"} on port ${current.port}`, "info");
}

async function track(name: string, workdir: string): Promise<void> {
  // The port mapping may not be published the instant `docker run` returns.
  let port: number | null = null;
  for (let i = 0; i < 50 && port === null; i++) {
    port = await getPublishedPort(name);
    if (port === null) await sleep(100);
  }
  current = port === null ? null : { name, port, workdir };
}

/** Removes the running sandbox container, if any. */
export async function stopContainer(ctx: ExtensionContext): Promise<void> {
  if (!current) return;
  const name = current.name;
  current = null;
  const res = await removeContainer(name);
  if (!res.ok) {
    ctx.ui.notify(`sandbox: failed to remove container ${name}: ${res.stderr.trim()}`, "warning");
    return;
  }
  ctx.ui.setStatus("sandbox", "");
}
