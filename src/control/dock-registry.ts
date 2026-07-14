import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { ManagedInstance, InstanceSnapshot } from "../core/managed-instance.js";

export interface InstanceFactoryInput {
  id: string;
  cwd: string;
  name?: string;
}

export type InstanceFactory = (input: InstanceFactoryInput) => Promise<ManagedInstance>;

export interface CreateRegistryInstanceInput {
  cwd: string;
  name?: string;
}

export class InstanceNotFoundError extends Error {
  constructor(readonly instanceId: string) {
    super(`Managed instance not found: ${instanceId}`);
    this.name = "InstanceNotFoundError";
  }
}

export class DockRegistry {
  private readonly instances = new Map<string, ManagedInstance>();

  constructor(
    private readonly factory: InstanceFactory,
    private readonly createId: () => string = randomUUID,
  ) {}

  async create(input: CreateRegistryInstanceInput): Promise<ManagedInstance> {
    const cwd = resolve(input.cwd);
    const cwdStat = await stat(cwd).catch(() => undefined);
    if (!cwdStat?.isDirectory()) throw new Error(`Working directory does not exist: ${cwd}`);

    const id = this.createId();
    if (this.instances.has(id)) throw new Error(`Generated duplicate instance identity: ${id}`);
    const instance = await this.factory({ id, cwd, name: input.name });
    if (instance.id !== id) {
      await instance.stop();
      throw new Error(`Instance factory returned unexpected identity: expected ${id}, got ${instance.id}`);
    }
    this.instances.set(id, instance);
    return instance;
  }

  get(instanceId: string): ManagedInstance {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new InstanceNotFoundError(instanceId);
    return instance;
  }

  list(): InstanceSnapshot[] {
    return [...this.instances.values()]
      .map((instance) => instance.snapshot())
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.instances.values()].map((instance) => instance.stop()));
  }
}
