import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { posix, relative, resolve } from "node:path";
import { Type } from "typebox";
import { read } from "./client.ts";
import { sandbox, startContainer } from "./watch.ts";

const MAX_BYTES = 50 * 1024;

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

/**
 * Maps a host-side path (relative to cwd) to the path inside the container,
 * where cwd is mounted at the sandbox workdir. Absolute paths pass through.
 */
export function toContainerPath(cwd: string, workdir: string, path: string): string {
  const clean = path.startsWith("@") ? path.slice(1) : path;
  const abs = resolve(cwd, clean);
  const rel = relative(cwd, abs);
  if (rel === "") return workdir;
  if (rel.startsWith("..") || posix.isAbsolute(rel)) return clean;
  return posix.join(workdir, rel.split(/[/\\]/).join("/"));
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
      // Reconcile the container with the current config before every read.
      await startContainer(ctx);

      const box = sandbox();
      if (!box) throw new Error("sandbox: no container running for this session");

      const target = toContainerPath(ctx.cwd, box.workdir, params.path);
      const content = await read(box.port, target);

      const lines = content.split("\n");
      const start = params.offset ? Math.max(0, params.offset - 1) : 0;
      const end = params.limit ? start + params.limit : lines.length;
      let text = lines.slice(start, end).join("\n");

      if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
        text = `${text.slice(0, MAX_BYTES)}\n\n[Output truncated at 50KB]`;
      }

      return {
        content: [{ type: "text" as const, text }],
        details: { path: target },
      };
    },
  });
}
