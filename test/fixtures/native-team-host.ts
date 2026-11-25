import { nativeTeamHost } from "../support/native-team.js";

// The parent owns the loopback model providers. This process owns only the test Host and its Workers.
const [root] = process.argv.slice(2);
if (!root || !process.send) throw new Error("Fork this Host with a native team's temporary directory");
const team = nativeTeamHost(root, { mainDockTools: true });
await team.startHost();
process.once("disconnect", async () => {
  await team.host!.stop();
  process.exit(0);
});
process.send("ready");
