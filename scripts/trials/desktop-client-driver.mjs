// Drives the official Desktop client inside the trial container through WebKitWebDriver; see
// scripts/trials/README.md for how the client gets there. The session is kept between calls.
//   node desktop-client-driver.mjs start            open the client
//   node desktop-client-driver.mjs shot NAME        screenshot to /shared/NAME.png
//   node desktop-client-driver.mjs text [CSS]       what the page, or one element, shows as text
//   node desktop-client-driver.mjs js 'return ...'  run a script in the page
//   node desktop-client-driver.mjs click CSS|text=LABEL
//   node desktop-client-driver.mjs type CSS TEXT    type into an element, without Enter
//   node desktop-client-driver.mjs key Enter|Escape|Tab
//   node desktop-client-driver.mjs quit             close the client
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
const BASE = "http://127.0.0.1:4444", KEEP = "/root/wd-session";
const [command, ...args] = process.argv.slice(2);
const call = async (method, path, body) => {
  const response = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(json.value).slice(0, 400)}`);
  return json.value;
};
const session = () => { if (!existsSync(KEEP)) throw new Error("no session; run start"); return readFileSync(KEEP, "utf8").trim(); };
const script = (source, values = []) => call("POST", `/session/${session()}/execute/sync`, { script: source, args: values });
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const find = async (selector) => {
  if (selector.startsWith("text=")) {
    const found = await script("const label = arguments[0]; return [...document.querySelectorAll('button, a, [role=button], [role=menuitem], [role=tab], [role=option], label, summary')].find((item) => item.offsetParent !== null && (item.innerText || item.getAttribute('aria-label') || '').trim().includes(label)) ?? null;", [selector.slice(5)]);
    if (!found) throw new Error(`nothing shows "${selector.slice(5)}"`);
    return found[ELEMENT];
  }
  return (await call("POST", `/session/${session()}/element`, { using: "css selector", value: selector }))[ELEMENT];
};

if (command === "start") {
  const value = await call("POST", "/session", { capabilities: { alwaysMatch: { "webkitgtk:browserOptions": { binary: "/opt/client/aludock-client-app", args: [] } } } });
  writeFileSync(KEEP, value.sessionId);
  console.log("session", value.sessionId);
} else if (command === "shot") {
  const png = await call("GET", `/session/${session()}/screenshot`);
  writeFileSync(`/shared/${args[0]}.png`, Buffer.from(png, "base64"));
  console.log(`/shared/${args[0]}.png`);
} else if (command === "text") {
  console.log(await script("const root = arguments[0] ? document.querySelector(arguments[0]) : document.body; return root ? root.innerText : '(no such element)';", [args[0] ?? null]));
} else if (command === "js") {
  console.log(JSON.stringify(await script(args[0]), null, 1));
} else if (command === "click") {
  await call("POST", `/session/${session()}/element/${await find(args[0])}/click`, {});
  console.log("clicked", args[0]);
} else if (command === "type") {
  await call("POST", `/session/${session()}/element/${await find(args[0])}/value`, { text: args[1] });
  console.log("typed", args[1].length, "chars");
} else if (command === "key") {
  const keys = { Enter: "\uE007", Escape: "\uE00C", Tab: "\uE004" };
  const active = (await call("GET", `/session/${session()}/element/active`))[ELEMENT];
  await call("POST", `/session/${session()}/element/${active}/value`, { text: keys[args[0]] ?? args[0] });
  console.log("pressed", args[0]);
} else if (command === "quit") {
  await call("DELETE", `/session/${session()}`).catch((error) => console.log(String(error)));
  rmSync(KEEP, { force: true });
} else {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(2, 10).join("\n"));
}
