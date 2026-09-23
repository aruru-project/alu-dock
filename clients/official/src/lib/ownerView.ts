import type { Ref } from 'vue'

/** Type-only consumer view. Form models and DOM refs opt into writable Pick
 * fields explicitly; other state and collections are read-only at the boundary. */
type ReadonlyValue<T> = T extends Set<infer Item> ? ReadonlySet<Item> : Readonly<T>
export type ReadonlyRefs<T> = {
  readonly [Key in keyof T]: T[Key] extends Ref<infer Value> ? Readonly<Ref<ReadonlyValue<Value>>> : T[Key]
}
