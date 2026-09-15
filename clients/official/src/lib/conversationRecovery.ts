/** Coalesce obsolete-subscription signals, but do not swallow a boundary from
 * the newly activated subscription while buffered events are being applied. */
export function createConversationRecovery() {
  type Recovery = { key: string; subscription: string | null; task: Promise<boolean>; next?: (isCurrent: () => boolean) => Promise<boolean> }
  let current: Recovery | null = null
  function run(key: string, subscription: string | null, operation: (isCurrent: () => boolean) => Promise<boolean>): Promise<boolean> {
    if (current?.key === key) {
      if (subscription && subscription !== current.subscription) {
        current.subscription = subscription
        current.next = operation
      }
      return current.task
    }
    const entry: Recovery = { key, subscription, task: null as unknown as Promise<boolean> }
    current = entry
    entry.task = Promise.resolve().then(async () => {
      let run: ((isCurrent: () => boolean) => Promise<boolean>) | undefined = operation
      let result = false
      while (run && current === entry) {
        entry.next = undefined
        result = await run(() => current === entry)
        run = entry.next
      }
      return current === entry && result
    }).finally(() => { if (current === entry) current = null })
    return entry.task
  }
  return { run, invalidate: () => { current = null } }
}
