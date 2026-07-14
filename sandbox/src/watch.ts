import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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

let current: string | null = null;
let currentPort: number | null = null;

/** Host port of the running sandbox server, or null when no container is up. */
export function serverPort(): number | null {
  return currentPort;
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

  if (running === hash) {
    current = name;
    currentPort = await getPublishedPort(name);
    ctx.ui.setStatus("sandbox", `container ${name} up on :${currentPort}`);
    return;
  }

  const changed = running !== null;
  ctx.ui.setStatus("sandbox", changed ? "config changed; restarting container…" : "starting container…");

  if (!(await ensureImage(config, changed))) {
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

  current = name;
  currentPort = await getPublishedPort(name);
  ctx.ui.setStatus("sandbox", `container ${name} up on :${currentPort}`);
  ctx.ui.notify(`sandbox: container ${name} ${changed ? "restarted" : "started"} on port ${currentPort}`, "info");
}

/** Removes the running sandbox container, if any. */
export async function stopContainer(ctx: ExtensionContext): Promise<void> {
  if (!current) return;
  const name = current;
  current = null;
  currentPort = null;
  const res = await removeContainer(name);
  if (!res.ok) {
    ctx.ui.notify(`sandbox: failed to remove container ${name}: ${res.stderr.trim()}`, "warning");
    return;
  }
  ctx.ui.setStatus("sandbox", "");
}
