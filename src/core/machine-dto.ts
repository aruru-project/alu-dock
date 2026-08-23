export const MACHINE_PLATFORMS = ["linux", "windows"] as const;
export type MachinePlatform = typeof MACHINE_PLATFORMS[number];

export interface MachineDto {
  hostId: string;
  name: string;
  kind: "main" | "subhost";
  available: boolean;
  platform?: MachinePlatform;
  homePath?: string;
  workspaceRoots?: string[];
}

export interface MachinesResult {
  machines: MachineDto[];
}
