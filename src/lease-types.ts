/**
 * THE LEASE SHAPES, MIRRORED STRUCTURALLY — `dsh-memory/src/lease-types.ts`.
 *
 * WHY THESE ARE DECLARED HERE INSTEAD OF IMPORTED FROM `dsh-paradise`
 *
 * A type-only import would be erased before runtime, so importing them from the layer would "work" —
 * but it would still make this package's BUILD depend on the layer's source layout, and `dsh-memory` is
 * meant to be loadable on its own. What the bridge actually needs is the SHAPE of the record it receives
 * and passes back, and a structural mirror is exactly that.
 *
 * THE DRIFT RISK IS REAL AND IS GUARDED, NOT ASSUMED: `test/lifecycle-dispose.test.mjs` (and the lock
 * tests) exercise a real record produced by the real adapter, so a rename in the layer turns into a
 * failing assertion here rather than a silent `undefined` in a critical section.
 */

/** A held claim on one key — the fields this package reads and hands back. */
export interface LeaseRecord {
  readonly key: string
  readonly owner: string
  readonly epoch: number
  readonly acquiredAt: number
  readonly expiresAt: number
  /** Diagnostics only; the layer records the caller's label when one is given. */
  readonly label?: string
}

/** What the bridge uses from the layer's lease adapter. */
export interface LeaseAdapter {
  readonly name: string
  readonly exclusive: boolean
}
