import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setTimeout as sleep } from "node:timers/promises";
import { type Backend, configHash, containerName, getBackend } from "./backend.ts";
import type { ConnectionTarget } from "./client.ts";
import { loadConfig } from "./config.ts";

export interface Sandbox {
  name: string;
  /** Host the sandbox server is reachable on (loopback or container IP). */
  host: string;
  port: number;
  /** Container path that the session cwd is mounted at. */
  workdir: string;
}

let current: Sandbox | null = null;

/** Handle for the running sandbox, or null when no container is up. */
export function sandbox(): Sandbox | null {
  return current;
}

function statusMessage(backend: Backend, msg: string): string {
  const runtime = backend.name === "container" ? "apple" : backend.name;
  return `[📦 ${runtime} ${msg}]`;
}

/** Clears the sandbox status line and reports a startup error to the user. */
function fail(ctx: ExtensionContext, msg: string): void {
  ctx.ui.setStatus("sandbox", "");
  ctx.ui.notify(msg, "error");
}

/**
 * Ensures a sandbox container is running for this session. Rebuilds the image
 * and restarts the container when the config has changed; no-ops when the
 * running container already matches the current config.
 */
export async function startContainer(ctx: ExtensionContext): Promise<void> {
  let config;
  try {
    ({ config } = await loadConfig(ctx.cwd));
  } catch (err: any) {
    ctx.ui.notify(`sandbox: invalid config: ${err?.message ?? err}`, "error");
    return;
  }

  const backend = await getBackend(config);
  if (!(await backend.available())) {
    ctx.ui.notify(`sandbox: ${backend.name} not found; skipping container startup`, "warning");
    return;
  }

  const name = containerName(config, ctx.sessionManager.getSessionId());
  const hash = configHash(config);
  const running = await backend.runningConfigHash(name);

  // Reuse the running container only when it matches the config AND still
  // exposes a reachable endpoint. Otherwise fall through and (re)start it.
  if (running === hash) {
    await track(backend, name, config.workdir);
    if (current) {
      ctx.ui.setStatus("sandbox", statusMessage(backend, `${current.host}:${current.port}`));
      return;
    }
  }

  const changed = running !== null;
  ctx.ui.setStatus("sandbox", statusMessage(backend, changed ? "config changed; restarting container…" : "starting container…"));

  if (!(await backend.ensureImage(config))) {
    return fail(ctx, `sandbox: failed to build image ${config.image}`);
  }

  const run = await backend.startContainer(config, name, ctx.cwd);
  if (!run.ok) {
    return fail(ctx, `sandbox: failed to start container: ${run.stderr.trim()}`);
  }

  await track(backend, name, config.workdir);
  if (!current) {
    return fail(ctx, `sandbox: container ${name} started but no endpoint could be resolved`);
  }
  ctx.ui.setStatus("sandbox", statusMessage(backend, `${current.host}:${current.port}`));
  ctx.ui.notify(`sandbox: container ${name} ${changed ? "restarted" : "started"} on port ${current.port}`, "info");
}

async function track(backend: Backend, name: string, workdir: string): Promise<void> {
  // The endpoint may not be resolvable the instant the container starts.
  let target: ConnectionTarget | null = null;
  for (let i = 0; i < 50 && target === null; i++) {
    target = await backend.endpoint(name);
    if (target === null) await sleep(100);
  }
  current = target === null ? null : { name, ...target, workdir };
}

/** Removes the running sandbox container, if any. */
export async function stopContainer(ctx: ExtensionContext): Promise<void> {
  if (!current) return;
  const name = current.name;
  current = null;
  let config;
  try {
    ({ config } = await loadConfig(ctx.cwd));
  } catch {
    return;
  }
  const backend = await getBackend(config);
  const res = await backend.removeContainer(name);
  if (!res.ok) {
    ctx.ui.notify(`sandbox: failed to remove container ${name}: ${res.stderr.trim()}`, "warning");
    return;
  }
  ctx.ui.setStatus("sandbox", "");
}
