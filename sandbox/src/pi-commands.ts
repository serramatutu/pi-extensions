import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { dirname, posix, relative, resolve } from "node:path";
import { Type } from "typebox";
import { read, SandboxError, write } from "./client.ts";
import { addEnv, addEnvForward, addMount, loadConfig } from "./config.ts";
import { sandbox, type Sandbox, startContainer } from "./watch.ts";

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

/** Ensures a container is running and returns its handle. */
async function ensureBox(ctx: ExtensionContext): Promise<Sandbox> {
  await startContainer(ctx);
  const box = sandbox();
  if (!box) throw new Error("sandbox: no container running for this session");
  return box;
}

/** True when a container path is inside (or equal to) the given workdir. */
function isUnder(target: string, workdir: string): boolean {
  const base = workdir.replace(/\/+$/, "");
  return target === base || target.startsWith(base + "/");
}

/**
 * Prompts the user to grant a host path into the container, mounts it, restarts
 * the container, and returns the fresh handle. Returns null when denied.
 */
async function grantMount(
  ctx: ExtensionContext,
  prompt: string,
  source: string,
  target: string,
  readonly: boolean,
): Promise<Sandbox | null> {
  const choice = await ctx.ui.select(prompt, ["Grant access", "Deny access"]);
  if (choice !== "Grant access") return null;

  const cfgPath = await addMount(ctx.cwd, { source, target, readonly });
  ctx.ui.notify(`sandbox: granted access to ${source} (mounted at ${target}, saved to ${cfgPath})`, "info");

  // Config changed → reconcile restarts the container with the new mount.
  await startContainer(ctx);
  return sandbox();
}

/**
 * Reads a file from the sandbox. When the file is missing inside the container
 * but present on the host, prompts the user to grant access; on approval the
 * host file is mounted, the container reconciled, and the read retried.
 */
async function readWithGrant(ctx: ExtensionContext, path: string): Promise<string> {
  const box = await ensureBox(ctx);
  const hostAbs = resolve(ctx.cwd, stripAt(path));
  const target = toContainerPath(ctx.cwd, box.workdir, path);

  try {
    return await read(box.port, target);
  } catch (err: any) {
    const missing = err instanceof SandboxError && err.status === "not_found";
    if (!missing || !ctx.hasUI || !existsSync(hostAbs)) throw err;

    const granted = await grantMount(
      ctx,
      `Sandbox cannot access "${stripAt(path)}". It exists on the host — grant the agent access?`,
      hostAbs,
      target,
      true,
    );
    if (!granted) throw err;
    return await read(granted.port, target);
  }
}

/**
 * Ensures the container path is writable back to the host. Paths under the cwd
 * mount already are. For paths outside it, prompts the user to grant a writable
 * mount (the file itself when it exists, otherwise its parent directory so a new
 * file can be created), then returns the fresh container handle.
 */
async function ensureWritable(ctx: ExtensionContext, box: Sandbox, path: string, target: string): Promise<Sandbox> {
  if (isUnder(target, box.workdir)) return box;

  const { config } = await loadConfig(ctx.cwd);
  const covered = config.mounts.some((m) => !m.readonly && isUnder(target, m.target));
  if (covered) return box;

  if (!ctx.hasUI) throw new Error(`sandbox: cannot write "${stripAt(path)}" outside the workspace without a writable mount`);

  const hostAbs = resolve(ctx.cwd, stripAt(path));
  const fileExists = existsSync(hostAbs);
  const source = fileExists ? hostAbs : dirname(hostAbs);
  const mountTarget = fileExists ? target : posix.dirname(target);
  if (!existsSync(source)) throw new Error(`sandbox: cannot write "${stripAt(path)}": ${source} does not exist on the host`);

  const granted = await grantMount(
    ctx,
    `Sandbox wants to write "${stripAt(path)}" outside the workspace — grant write access to ${source}?`,
    source,
    mountTarget,
    false,
  );
  if (!granted) throw new Error(`sandbox: write access to ${source} denied`);
  return granted;
}

/** Writes a file to the sandbox, granting a writable mount when needed. */
async function writeWithGrant(ctx: ExtensionContext, path: string, content: string): Promise<string> {
  let box = await ensureBox(ctx);
  const target = toContainerPath(ctx.cwd, box.workdir, path);
  box = await ensureWritable(ctx, box, path, target);
  await write(box.port, target, content);
  return target;
}

interface Edit {
  oldText: string;
  newText: string;
}

/** Applies exact-text replacements in order; each oldText must be unique. */
function applyEdits(content: string, edits: Edit[]): string {
  let result = content;
  for (const { oldText, newText } of edits) {
    const idx = result.indexOf(oldText);
    if (idx === -1) throw new Error(`edit: oldText not found: ${JSON.stringify(oldText.slice(0, 60))}`);
    if (result.indexOf(oldText, idx + oldText.length) !== -1) {
      throw new Error(`edit: oldText is not unique: ${JSON.stringify(oldText.slice(0, 60))}`);
    }
    result = result.slice(0, idx) + newText + result.slice(idx + oldText.length);
  }
  return result;
}

/**
 * Edits a file in the sandbox: reads current contents, applies the edits, and
 * writes them back — all over the sandbox protocol. Files outside the cwd mount
 * are made writable first so the edited contents land on the host.
 */
async function editWithGrant(ctx: ExtensionContext, path: string, edits: Edit[]): Promise<string> {
  let box = await ensureBox(ctx);
  const target = toContainerPath(ctx.cwd, box.workdir, path);
  box = await ensureWritable(ctx, box, path, target);

  const content = await read(box.port, target);
  const updated = applyEdits(content, edits);
  await write(box.port, target, updated);
  return target;
}

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "request_env_var",
    label: "request_env_var (sandbox)",
    description: "Request a missing environment variable from the user. Use it when a command fails due to missing environment config.",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the missing environment variable to request from the user" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = await requestEnvVar(ctx, params.name);
      return { content: [{ type: "text" as const, text }], details: { name: params.name } };
    },
  });

  pi.registerTool({
    name: "read",
    label: "read (sandbox)",
    description: "Read the contents of a file from the sandbox container filesystem.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
    }),

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

  pi.registerTool({
    name: "write",
    label: "write (sandbox)",
    description: "Write contents to a file on the sandbox container filesystem, creating parent directories.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
      content: Type.String({ description: "Full contents to write to the file" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const target = await writeWithGrant(ctx, params.path, params.content);
      const bytes = Buffer.byteLength(params.content, "utf8");
      return {
        content: [{ type: "text" as const, text: `Wrote ${bytes} bytes to ${target}` }],
        details: { path: target },
      };
    },
  });

  pi.registerTool({
    name: "edit",
    label: "edit (sandbox)",
    description: "Edit a file on the sandbox container filesystem using exact-text replacements.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({ description: "Exact text to replace; must be unique in the file" }),
          newText: Type.String({ description: "Replacement text" }),
        }),
        { description: "One or more exact-text replacements applied in order" },
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const target = await editWithGrant(ctx, params.path, params.edits);
      return {
        content: [{ type: "text" as const, text: `Applied ${params.edits.length} edit(s) to ${target}` }],
        details: { path: target },
      };
    },
  });
}
