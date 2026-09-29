/** A lower store's notification to the stores built on top of it. The upper
 * store subscribes when it is created, so the lower store never imports it. */
export function createSignal<Args extends unknown[]>() {
  const handlers = new Set<(...args: Args) => void>()
  return {
    on(handler: (...args: Args) => void) {
      handlers.add(handler)
      return () => { handlers.delete(handler) }
    },
    emit(...args: Args) {
      for (const handler of [...handlers]) handler(...args)
    },
  }
}
