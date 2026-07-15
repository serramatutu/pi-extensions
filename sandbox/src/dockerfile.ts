import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_PORT, type SandboxConfig } from "./config.ts";

const SERVER_PACKAGES = ["socat", "python3"];

const HANDLER_PATH = "/usr/local/bin/sandbox-handler";
const HANDLER_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "handler.py");

export function readHandlerScript(): string {
  return readFileSync(HANDLER_SOURCE, "utf8");
}

export function generateDockerfile(config: SandboxConfig): string {
  const packages = [...new Set([...config.tools, ...SERVER_PACKAGES])];
  const lines: string[] = [`FROM ${config.baseImage}`];

  const pkgList = packages.map((tool) => `    ${tool}`).join(" \\\n");
  lines.push("", `RUN apk add --no-cache \\\n${pkgList}`);

  // Provide the Debian-style `fdfind` alias when `fd` is installed.
  if (packages.includes("fd")) {
    lines.push("", 'RUN ln -s "$(command -v fd)" /usr/local/bin/fdfind');
  }

  // Bake the handler script via base64 to avoid Dockerfile quoting issues.
  const encoded = Buffer.from(readHandlerScript(), "utf8").toString("base64");
  lines.push("", `RUN echo "${encoded}" | base64 -d > ${HANDLER_PATH} && chmod +x ${HANDLER_PATH}`);

  lines.push(
    "",
    `WORKDIR ${config.workdir}`,
    "",
    `EXPOSE ${SERVER_PORT}`,
    "",
    `CMD ["socat", "TCP-LISTEN:${SERVER_PORT},reuseaddr,fork", "EXEC:${HANDLER_PATH}"]`,
    "",
  );
  return lines.join("\n");
}
