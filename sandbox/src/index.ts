import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startContainer, stopContainer } from "./watch.ts";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => startContainer(ctx));
  pi.on("session_shutdown", (_event, ctx) => stopContainer(ctx));
}
