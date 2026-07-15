import { createHash } from "node:crypto";
import type { ConnectionTarget } from "./client.ts";
import type { SandboxConfig } from "./config.ts";

/** Result of a backend CLI invocation. */
export interface Result {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * A container backend: the impure surface the rest of the sandbox talks to.
 * Implementations shell out to a specific CLI (docker, Apple's container, …).
 * Everything else reaches the running container through the TCP endpoint this
 * returns from {@link Backend.endpoint}.
 */
export interface Backend {
  /** Backend id used in status and error messages, e.g. "docker". */
  readonly name: string;
  /** True when the backend CLI is installed and usable. */
  available(): Promise<boolean>;
  /** Builds the sandbox image when missing or stale. Returns success. */
  ensureImage(config: SandboxConfig): Promise<boolean>;
  /** Config hash of a running container, or null when it isn't running. */
  runningConfigHash(name: string): Promise<string | null>;
  /** (Re)starts the container fresh, removing any stale one of the same name. */
  startContainer(config: SandboxConfig, name: string, cwd: string): Promise<Result>;
  /** Removes the container by name. */
  removeContainer(name: string): Promise<Result>;
  /** Host+port to reach the in-container server, or null if unresolved. */
  endpoint(name: string): Promise<ConnectionTarget | null>;
}

/** Stable hash of the config, used to detect when a container is out of date. */
export function configHash(config: SandboxConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

/** Derives a container name from the config prefix and session id. */
export function containerName(config: SandboxConfig, sessionId: string): string {
  return config.namePrefix + sessionId.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

/** Resolves the backend implementation selected by the config. */
export async function getBackend(config: SandboxConfig): Promise<Backend> {
  switch (config.backend) {
    case "container": {
      const { appleBackend } = await import("./backends/apple.ts");
      return appleBackend;
    }
    case "docker":
    default: {
      const { dockerBackend } = await import("./backends/docker.ts");
      return dockerBackend;
    }
  }
}
