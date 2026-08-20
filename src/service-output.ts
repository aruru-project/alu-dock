import type { UserServiceStatus } from "./deployment/user-service.js";

export type HumanServiceAction = "install" | "start" | "stop" | "restart" | "status";

export function renderHumanServiceStatus(action: HumanServiceAction, status: UserServiceStatus): string {
  let headline: string;
  if (action === "stop") headline = "Alu Dock is stopped.";
  else if (status.ready) headline = action === "install" ? "Alu Dock is installed and ready." : "Alu Dock is ready.";
  else if (!status.installed) headline = "Alu Dock is not installed for this user.";
  else if (status.activeState === "active") headline = "Alu Dock is running, but it is not ready yet.";
  else if (action === "install") headline = "Alu Dock is installed, but it is not running.";
  else headline = "Alu Dock is not running.";

  const lines = [headline];
  if (!status.ready && action !== "stop") {
    lines.push(!status.installed
      ? "Install it: aludock service install --now"
      : status.activeState === "active"
        ? "Next: aludock service logs --lines 200"
        : "Start it: aludock service start");
  }
  const logoutWarning = status.diagnostics.find((message) => message.includes("after you log out"));
  if (logoutWarning) lines.push(logoutWarning);
  return `${lines.join("\n")}\n`;
}

export function renderHumanServiceUninstall(removed: boolean): string {
  return removed
    ? "Alu Dock service setup was removed.\n"
    : "Alu Dock service setup was already absent.\n";
}
