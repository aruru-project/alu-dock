import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { getGlobalDispatcher } from "undici";

import { configurePiNetwork } from "../../src/pi/configure-pi-network.js";

const [proxyUrl, source, transport] = process.argv.slice(2);
if (!proxyUrl || (source !== "settings" && source !== "environment")) {
  throw new Error("pi-network-probe requires PROXY_URL settings|environment fetch|websocket");
}
if (transport !== "fetch" && transport !== "websocket") {
  throw new Error("pi-network-probe transport must be fetch or websocket");
}

for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
  delete process.env[key];
}
process.env.NO_PROXY = "";
process.env.no_proxy = "";

const settings = source === "settings"
  ? SettingsManager.inMemory({ httpProxy: proxyUrl, httpIdleTimeoutMs: 2_000 })
  : SettingsManager.inMemory({ httpIdleTimeoutMs: 2_000 });
if (source === "environment") {
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
}
configurePiNetwork(settings);

if (transport === "fetch") {
  await fetch("https://alu-dock-proxy-probe.invalid/fetch", {
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined);
} else {
  await new Promise<void>((resolveProbe) => {
    const socket = new WebSocket("wss://alu-dock-proxy-probe.invalid/websocket");
    const timeout = setTimeout(() => {
      socket.close();
      resolveProbe();
    }, 2_000);
    const finish = (): void => {
      clearTimeout(timeout);
      resolveProbe();
    };
    socket.addEventListener("open", finish, { once: true });
    socket.addEventListener("error", finish, { once: true });
  });
}

process.stdout.write(`${JSON.stringify({
  dispatcher: getGlobalDispatcher().constructor.name,
  httpProxy: process.env.HTTP_PROXY,
  httpsProxy: process.env.HTTPS_PROXY,
})}\n`);
