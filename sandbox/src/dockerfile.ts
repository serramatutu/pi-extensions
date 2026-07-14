import { SERVER_PORT, type SandboxConfig } from "./config.ts";

const SERVER_PACKAGES = ["socat", "jq", "coreutils"];

const HANDLER_PATH = "/usr/local/bin/sandbox-handler";

const HANDLER_SCRIPT = `#!/bin/sh
set -eu
req=$(cat)
cmd=$(printf '%s' "$req" | jq -r '.cmd // empty')
case "$cmd" in
read)
  path=$(printf '%s' "$req" | jq -r '.path // empty')
  if [ -z "$path" ]; then
    jq -cn '{ok:false, error:"missing path"}'
  elif [ -f "$path" ]; then
    content=$(base64 "$path" | tr -d '\\n')
    jq -cn --arg c "$content" '{ok:true, contentBase64:$c}'
  else
    jq -cn --arg p "$path" '{ok:false, error:("no such file: " + $p)}'
  fi
  ;;
*)
  jq -cn --arg c "$cmd" '{ok:false, error:("unknown command: " + $c)}'
  ;;
esac
`;

/**
 * Generates an Alpine-based Dockerfile from the sandbox config. The image runs a
 * socat server that executes tool-call requests received over a TCP socket.
 */
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
  const encoded = Buffer.from(HANDLER_SCRIPT, "utf8").toString("base64");
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
