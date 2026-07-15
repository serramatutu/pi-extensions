import type { Backend } from "../backend.ts";

/**
 * Backend for Apple's `container` CLI (github.com/apple/container).
 *
 * Not implemented yet. The interface is shared with the Docker backend, but the
 * two diverge in ways that still need to be handled here:
 *   - Networking: `container` assigns each container its own IP rather than
 *     publishing a loopback host port, so `endpoint()` should return the
 *     container IP and SERVER_PORT (no `-p` host mapping in `startContainer`).
 *   - Inspect/labels: `container inspect` emits JSON, not Docker Go-templates;
 *     config/dockerfile hash tracking must be reworked (JSON parse or a local
 *     state file) instead of `--label` + templated inspect.
 *   - Build: `container build` expects a context directory, so write the
 *     generated Dockerfile to a temp dir instead of piping it via stdin.
 */
const NOT_IMPLEMENTED = "sandbox: the Apple container backend is not implemented yet";

export const appleBackend: Backend = {
  name: "container",
  async available() {
    return false;
  },
  async ensureImage() {
    throw new Error(NOT_IMPLEMENTED);
  },
  async runningConfigHash() {
    throw new Error(NOT_IMPLEMENTED);
  },
  async startContainer() {
    throw new Error(NOT_IMPLEMENTED);
  },
  async removeContainer() {
    throw new Error(NOT_IMPLEMENTED);
  },
  async endpoint() {
    throw new Error(NOT_IMPLEMENTED);
  },
};
