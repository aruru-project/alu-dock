export const WORKER_INCIDENT_STDERR_MAX_BYTES = 256 * 1024;

export interface WorkerIncidentEvidence {
  instanceId: string;
  workName?: string;
  runtimeGeneration: number;
  workerIncarnation: string;
  occurredAt: string;
  cause: string;
  exitCode?: number;
  signal?: string;
  stderrTail: string;
  stderrTruncated: boolean;
  platform: NodeJS.Platform;
  architecture: string;
  nodeVersion: string;
}

export interface WorkerIncidentRecorder {
  record(evidence: WorkerIncidentEvidence): Promise<void>;
}
