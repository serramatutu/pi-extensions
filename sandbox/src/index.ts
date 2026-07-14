import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./pi-commands.ts";
import { startContainer, stopContainer } from "./watch.ts";

export default function (pi: ExtensionAPI) {
  registerCommands(pi);
  pi.on("session_start", (_event, ctx) => startContainer(ctx));
  pi.on("session_shutdown", (_event, ctx) => stopContainer(ctx));
}
