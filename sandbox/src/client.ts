import net from "node:net";

interface Request {
  cmd: string;
  [key: string]: unknown;
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
  if (!res.ok) throw new Error(`sandbox: ${res.error}`);
  return Buffer.from(res.contentBase64, "base64").toString("utf8");
}
