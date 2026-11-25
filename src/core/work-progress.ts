/** The numbers of a child Work's parent messages. Task 0 is owed from creation. */
export interface WorkProgress {
  /** Never reused, even if a delivery fails. */
  next: number;
  handed: number;
  /** The latest number its delivered final results answered. */
  answered: number;
  /** The latest taken back or accounted for by a notice that the child left. */
  closed: number;
}
export const INITIAL_WORK_PROGRESS: Readonly<WorkProgress> = { next: 1, handed: 0, answered: -1, closed: -1 };

/** On reopen the Worker learns what it and its own children still owe, not what to execute. */
export interface WorkRecovery {
  afterHostCrash?: true;
  own?: WorkProgress;
  children: Array<{ id: string; name: string; handed: number; settled: number }>;
}

export function parseWorkProgress(raw: unknown): WorkProgress {
  if (!raw || typeof raw !== "object" || Object.keys(raw).some((key) => !(Object.hasOwn(INITIAL_WORK_PROGRESS, key)))) {
    throw new Error("Invalid child Work progress");
  }
  const { next, handed, answered, closed } = raw as WorkProgress;
  if (![next, handed, answered, closed].every(Number.isSafeInteger) || next < 1 || handed < 0 || answered < -1 || closed < -1
    || Math.max(handed, answered, closed) >= next) throw new Error("Invalid child Work message numbers");
  return { next, handed, answered, closed };
}

export function parseWorkRecovery(raw: unknown): WorkRecovery {
  const { own, children, afterHostCrash } = (raw ?? {}) as WorkRecovery;
  if (!Array.isArray(children) || !children.every((child) => child && typeof child.id === "string" && typeof child.name === "string"
    && Number.isSafeInteger(child.handed) && Number.isSafeInteger(child.settled) && child.handed >= 0 && child.settled >= -1)) {
    throw new Error("Invalid child Work progress on reopen");
  }
  return { children, ...(afterHostCrash === true ? { afterHostCrash } : {}), ...(own === undefined ? {} : { own: parseWorkProgress(own) }) };
}
