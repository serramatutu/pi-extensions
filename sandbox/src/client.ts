import net from "node:net";

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

/**
 * Opens a TCP connection to the sandbox server on the given host port, sends a
 * single JSON request, and resolves with the parsed JSON response.
 */
function sendRequest(port: number, req: Request): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
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
export async function read(port: number, path: string): Promise<string> {
  const res = await sendRequest(port, { cmd: "read", path });
  if (!res.ok) throw new SandboxError(res.error ?? "unknown error", res.status ?? "error");
  return Buffer.from(res.contentBase64, "base64").toString("utf8");
}

/** Writes contents to a file on the container filesystem, creating parent dirs. */
export async function write(port: number, path: string, content: string): Promise<void> {
  const contentBase64 = Buffer.from(content, "utf8").toString("base64");
  const res = await sendRequest(port, { cmd: "write", path, contentBase64 });
  if (!res.ok) throw new SandboxError(res.error ?? "unknown error", res.status ?? "error");
}
