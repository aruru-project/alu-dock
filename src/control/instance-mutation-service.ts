import type { AttachmentService } from "./attachment-service.js";
import type { ProjectTrustChoice } from "./project-trust.js";
import type { ImagePathDto } from "../core/instance-dto.js";
import type { DockRegistry } from "./dock-registry.js";
import type { OperationLedger } from "./operation-ledger.js";
import { ProtocolValidationError } from "./protocol.js";

export interface CreateInstanceMutation {
  operationId: string;
  cwd: string;
  name?: string;
  trustChallengeId?: string;
  projectTrustDecision?: ProjectTrustChoice;
}

export interface SubmitCommandMutation {
  operationId: string;
  instanceId: string;
  message: string;
  images?: ImagePathDto[];
  attachments?: string[];
  delivery: "auto" | "prompt" | "steer" | "followUp";
}

/** Canonical Host application boundary shared by Protocol V2 and Agent-facing Dock tools. */
export class InstanceMutationService {
  constructor(
    private readonly registry: DockRegistry,
    private readonly operationLedger: OperationLedger,
    private readonly attachmentService?: AttachmentService,
  ) {}

  create(input: CreateInstanceMutation) {
    return this.operationLedger.run(input.operationId, "instance.create", input, async () => {
      const instance = await this.registry.create(input);
      return { instance: instance.snapshot() };
    });
  }

  submit(input: SubmitCommandMutation) {
    return this.operationLedger.run(input.operationId, "command.submit", input, async () => {
      const instance = this.registry.get(input.instanceId);
      const attachments = input.attachments === undefined
        ? undefined
        : await this.attachmentService?.getMany(input.attachments);
      if (input.attachments !== undefined && attachments === undefined) {
        throw new ProtocolValidationError("capability_missing", "Attachment storage is unavailable");
      }
      const receipt = await instance.submit(input.message, input.delivery, input.operationId, input.images, attachments);
      return { receipt, instance: instance.snapshot() };
    });
  }
}
