import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { posix, relative, resolve } from "node:path";
import { Type } from "typebox";
import { read, SandboxError } from "./client.ts";
import { addMount } from "./config.ts";
import { sandbox, startContainer } from "./watch.ts";

const MAX_BYTES = 50 * 1024;

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

/**
 * Registers a `read` tool that overrides the built-in one, servicing reads from
 * the session's sandbox container over TCP instead of the host filesystem.
 */
export function registerCommands(pi: ExtensionAPI): void {
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
