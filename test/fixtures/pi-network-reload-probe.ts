import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { configurePiNetwork } from "../../src/pi/configure-pi-network.js";

for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
  delete process.env[key];
}

const snapshots: Array<{ httpProxy?: string; httpsProxy?: string }> = [];
for (const httpProxy of ["http://127.0.0.1:41001", "http://127.0.0.1:41002", undefined]) {
  const settings = SettingsManager.inMemory({
    ...(httpProxy === undefined ? {} : { httpProxy }),
    httpIdleTimeoutMs: 2_000,
  });
  configurePiNetwork(settings);
  snapshots.push({
    ...(process.env.HTTP_PROXY === undefined ? {} : { httpProxy: process.env.HTTP_PROXY }),
    ...(process.env.HTTPS_PROXY === undefined ? {} : { httpsProxy: process.env.HTTPS_PROXY }),
  });
}

process.stdout.write(JSON.stringify(snapshots));
