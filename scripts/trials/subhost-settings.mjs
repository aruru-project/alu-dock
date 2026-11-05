// Saves "use as SubHost" the way the Hub's Settings page does, for cross-machine-docker.sh.
const { MachineSettingsState } = await import("/opt/alu/dist/src/control/machine-settings-state.js");
const settings = await new MachineSettingsState("/root/state/machines").switchToSubHost({ mainAddress: process.argv[2], port: 7443, name: "Laptop" });
console.log(`SubHost settings saved: ${settings.role} → ${settings.subhost?.mainAddress}`);
