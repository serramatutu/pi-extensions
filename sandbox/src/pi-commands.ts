import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { posix, relative, resolve } from "node:path";
import { Type } from "typebox";
import { read, SandboxError } from "./client.ts";
import { addEnv, addEnvForward, addMount } from "./config.ts";
import { sandbox, startContainer } from "./watch.ts";

const TYPE_VALUE = "Type in a value";
const FORWARD_HOST = "Forward from host";
const DENY = "Deny access";

/**
 * Prompts the user to satisfy a missing sandbox env var. Always offers typing a
 * value or denying; when the host harness has the same var set, also offers
 * forwarding it. Typing writes the config "env" map; forwarding writes
 * "envForward".
 */
async function requestEnvVar(ctx: ExtensionContext, name: string): Promise<string> {
  if (!ctx.hasUI) throw new Error("sandbox: cannot request an env var without a UI");

  const options = name in process.env ? [TYPE_VALUE, FORWARD_HOST, DENY] : [TYPE_VALUE, DENY];

  const choice = await ctx.ui.select(`Sandbox is missing environment variable "${name}". How should it be provided?`, options);

  if (choice === TYPE_VALUE) {
    const value = await ctx.ui.input(`Value for ${name}`);
    if (value === undefined) {
      ctx.ui.notify(`sandbox: cancelled request for ${name}`, "info");
      return `User cancelled the request for ${name}.`;
    }
    const cfgPath = await addEnv(ctx.cwd, name, value);
    ctx.ui.notify(`sandbox: set ${name} in ${cfgPath}`, "info");
    // Config changed → reconcile restarts the container with the new env.
    await startContainer(ctx);
    return `User provided a value for ${name}; it is now set in the sandbox.`;
  }

  if (choice === FORWARD_HOST) {
    const cfgPath = await addEnvForward(ctx.cwd, name);
    ctx.ui.notify(`sandbox: forwarding ${name} from host (saved to ${cfgPath})`, "info");
    await startContainer(ctx);
    return `User chose to forward ${name} from the host; it is now available in the sandbox.`;
  }

  ctx.ui.notify(`sandbox: denied access to ${name}`, "info");
  return `User denied access to ${name}.`;
}

const MAX_BYTES = 50 * 1024;

const requestEnvVarSchema = Type.Object({
  name: Type.String({ description: "Name of the missing environment variable to request from the user" }),
});

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

function stripAt(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

/**
 * Maps a host-side path (relative to cwd) to the path inside the container,
 * where cwd is mounted at the sandbox workdir. Paths outside cwd resolve to
 * their absolute host path, which is also where a granted mount is attached.
 */
export function toContainerPath(cwd: string, workdir: string, path: string): string {
  const abs = resolve(cwd, stripAt(path));
  const rel = relative(cwd, abs);
  if (rel === "") return workdir;
  if (rel.startsWith("..") || posix.isAbsolute(rel)) return abs;
  return posix.join(workdir, rel.split(/[/\\]/).join("/"));
}

/**
 * Reads a file from the sandbox. When the file is missing inside the container
 * but present on the host, prompts the user to grant access; on approval the
 * host file is mounted, the container reconciled, and the read retried.
 */
async function readWithGrant(ctx: ExtensionContext, path: string): Promise<string> {
  await startContainer(ctx);
  let box = sandbox();
  if (!box) throw new Error("sandbox: no container running for this session");

  const hostAbs = resolve(ctx.cwd, stripAt(path));
  const target = toContainerPath(ctx.cwd, box.workdir, path);

  try {
    return await read(box.port, target);
  } catch (err: any) {
    const missing = err instanceof SandboxError && err.status === "not_found";
    if (!missing || !ctx.hasUI || !existsSync(hostAbs)) throw err;

    const choice = await ctx.ui.select(`Sandbox cannot access "${stripAt(path)}". It exists on the host — grant the agent access?`, [
      "Grant access",
      "Deny access",
    ]);
    if (choice !== "Grant access") throw err;

    const cfgPath = await addMount(ctx.cwd, { source: hostAbs, target, readonly: true });
    ctx.ui.notify(`sandbox: granted access to ${hostAbs} (mounted at ${target}, saved to ${cfgPath})`, "info");

    // Config changed → reconcile restarts the container with the new mount.
    await startContainer(ctx);
    box = sandbox();
    if (!box) throw err;
    return await read(box.port, target);
  }
}

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "request_env_var",
    label: "request_env_var (sandbox)",
    description:
      "Request a missing environment variable from the user. Use it when a command fails due to missing environment config.",
    parameters: requestEnvVarSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = await requestEnvVar(ctx, params.name);
      return { content: [{ type: "text" as const, text }], details: { name: params.name } };
    },
  });

  pi.registerTool({
    name: "read",
    label: "read (sandbox)",
    description: "Read the contents of a file from the sandbox container filesystem.",
    parameters: readSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const content = await readWithGrant(ctx, params.path);

      const lines = content.split("\n");
      const start = params.offset ? Math.max(0, params.offset - 1) : 0;
      const end = params.limit ? start + params.limit : lines.length;
      let text = lines.slice(start, end).join("\n");

      if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
        text = `${text.slice(0, MAX_BYTES)}\n\n[Output truncated at 50KB]`;
      }

      return {
        content: [{ type: "text" as const, text }],
        details: { path: toContainerPath(ctx.cwd, sandbox()?.workdir ?? "/workspace", params.path) },
      };
    },
  });
}
