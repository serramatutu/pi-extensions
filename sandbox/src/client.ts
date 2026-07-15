import net from "node:net";

/** Host and port to reach the sandbox server exposed by a backend. */
export interface ConnectionTarget {
  host: string;
  port: number;
}

interface Request {
  cmd: string;
  [key: string]: unknown;
}

/** Error carrying the protocol-level status returned by the sandbox server. */
export class SandboxError extends Error {
  readonly status: string;
  constructor(message: string, status: string) {
    super(`sandbox: ${message}`);
    this.name = "SandboxError";
    this.status = status;
  }
}

/** Throws a SandboxError when the server reported a failed response. */
function assertOk(res: any): void {
  if (!res.ok) throw new SandboxError(res.error ?? "unknown error", res.status ?? "error");
}

/**
 * Opens a TCP connection to the sandbox server at the given target, sends a
 * single JSON request, and resolves with the parsed JSON response.
 */
function sendRequest(target: ConnectionTarget, req: Request): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target.port, target.host);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(JSON.stringify(req)));
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error(`sandbox: invalid response: ${data}`));
      }
    });
    socket.on("error", reject);
  });
}

/** Reads a file from the container filesystem and returns its contents. */
export async function read(target: ConnectionTarget, path: string): Promise<string> {
  const res = await sendRequest(target, { cmd: "read", path });
  assertOk(res);
  return Buffer.from(res.contentBase64, "base64").toString("utf8");
}

/** Writes contents to a file on the container filesystem, creating parent dirs. */
export async function write(target: ConnectionTarget, path: string, content: string): Promise<void> {
  const contentBase64 = Buffer.from(content, "utf8").toString("base64");
  const res = await sendRequest(target, { cmd: "write", path, contentBase64 });
  assertOk(res);
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** Runs a shell command in the container and returns its captured output. */
export async function exec(target: ConnectionTarget, command: string, timeout?: number): Promise<ExecResult> {
  const res = await sendRequest(target, { cmd: "exec", command, timeout });
  assertOk(res);
  return {
    stdout: Buffer.from(res.stdoutBase64 ?? "", "base64").toString("utf8"),
    stderr: Buffer.from(res.stderrBase64 ?? "", "base64").toString("utf8"),
    exitCode: res.exitCode ?? 0,
    timedOut: res.status === "timeout",
  };
}
