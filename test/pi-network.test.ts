import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const compiledTestDirectory = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(compiledTestDirectory, "fixtures", "pi-network-probe.js");
const reloadFixturePath = join(compiledTestDirectory, "fixtures", "pi-network-reload-probe.js");

test("Pi SDK network bootstrap proxies fetch and WebSocket like the Pi CLI", { timeout: 15_000 }, async () => {
  const settingsFetch = await runProxyProbe("settings", "fetch");
  assert.match(settingsFetch.request, /^CONNECT alu-dock-proxy-probe\.invalid:443 HTTP\/1\.1$/m);
  assert.equal(settingsFetch.result.dispatcher, "EnvHttpProxyAgent");
  assert.equal(settingsFetch.result.httpProxy, settingsFetch.proxyUrl);
  assert.equal(settingsFetch.result.httpsProxy, settingsFetch.proxyUrl);

  const environmentWebSocket = await runProxyProbe("environment", "websocket");
  assert.match(environmentWebSocket.request, /^CONNECT alu-dock-proxy-probe\.invalid:443 HTTP\/1\.1$/m);
  assert.equal(environmentWebSocket.result.dispatcher, "EnvHttpProxyAgent");
  assert.equal(environmentWebSocket.result.httpProxy, environmentWebSocket.proxyUrl);
  assert.equal(environmentWebSocket.result.httpsProxy, environmentWebSocket.proxyUrl);
});

test("Pi SDK network bootstrap can replace and remove settings-owned proxy values", async () => {
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolveRun, rejectRun) => {
    execFile(process.execPath, [reloadFixturePath], { encoding: "utf8", timeout: 8_000 }, (error, stdout, stderr) => {
      if (error) rejectRun(new Error(`Network reload probe failed: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
      else resolveRun({ stdout, stderr });
    });
  });
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), [
    { httpProxy: "http://127.0.0.1:41001", httpsProxy: "http://127.0.0.1:41001" },
    { httpProxy: "http://127.0.0.1:41002", httpsProxy: "http://127.0.0.1:41002" },
    {},
  ]);
});

async function runProxyProbe(
  source: "settings" | "environment",
  transport: "fetch" | "websocket",
): Promise<{
  proxyUrl: string;
  request: string;
  result: { dispatcher: string; httpProxy?: string; httpsProxy?: string };
}> {
  let resolveRequest!: (request: string) => void;
  const requestReceived = new Promise<string>((resolve) => { resolveRequest = resolve; });
  const proxy = createServer((socket) => {
    let request = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      request += chunk;
      if (!request.includes("\r\n\r\n")) return;
      resolveRequest(request);
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    proxy.once("error", rejectListen);
    proxy.listen(0, "127.0.0.1", resolveListen);
  });
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Proxy probe did not bind a TCP port");
  const proxyUrl = `http://127.0.0.1:${address.port}`;

  try {
    const childResult = runFixture(proxyUrl, source, transport);
    let requestTimeout: NodeJS.Timeout | undefined;
    let request: string;
    try {
      request = await Promise.race([
        requestReceived,
        childResult.then<never>(() => {
          throw new Error(`${transport} probe exited before reaching the proxy`);
        }),
        new Promise<never>((_resolve, reject) => {
          requestTimeout = setTimeout(
            () => reject(new Error(`No ${transport} request reached the proxy`)),
            5_000,
          );
        }),
      ]);
    } finally {
      if (requestTimeout) clearTimeout(requestTimeout);
    }
    const result = await childResult;
    return { proxyUrl, request, result };
  } finally {
    await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()));
  }
}

async function runFixture(
  proxyUrl: string,
  source: "settings" | "environment",
  transport: "fetch" | "websocket",
): Promise<{ dispatcher: string; httpProxy?: string; httpsProxy?: string }> {
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolveRun, rejectRun) => {
    execFile(
      process.execPath,
      [fixturePath, proxyUrl, source, transport],
      { encoding: "utf8", timeout: 8_000 },
      (error, stdout, stderr) => {
        if (error) {
          rejectRun(new Error(`Network probe failed: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
        } else {
          resolveRun({ stdout, stderr });
        }
      },
    );
  });
  assert.equal(stderr, "");
  return JSON.parse(stdout) as { dispatcher: string; httpProxy?: string; httpsProxy?: string };
}
