/**
 * Read the slicing plugin's ledgers.
 *
 * DECOUPLING CONTRACT: dsh-memory never imports dsh-graft-slice. The only thing
 * shared between the two plugins is a FILE FORMAT — `.retired.json` (array of
 * source session ids) and `.transferred.json` (id → { newSessionId, at }). This
 * module is the whole of that coupling, and it is read-only.
 *
 * v0.18 — THE EPOCH
 *
 * The two plugins are released separately, and the format above is not versioned.
 * A ledger written by a newer `dsh-graft-slice` is a JSON object with an `epoch`
 * and a `payload`, and an older reader that just walks `Object.entries` finds no
 * session ids — or, worse, finds shape-compatible fields and harvests from a
 * record it only half understands. Attribution of a skill to a handoff nobody
 * verified is the failure mode this module now refuses to have.
 *
 * So each file is read as a RECORD with an epoch, and the reader has exactly four
 * outcomes per file:
 *
 *   absent / unreadable      → no entries, no complaint (first run is normal)
 *   epoch === SUPPORTED      → trust the payload
 *   epoch <  SUPPORTED       → trust it (a legacy bare array/object is epoch 1)
 *   epoch >  SUPPORTED       → REFUSE; report it and wait for the next retry
 *   envelope without payload → REFUSE (torn); report it and wait
 *
 * "Wait for the next retry" is deliberate: the writer's own write is atomic, so a
 * refused read means either a newer writer or an interrupted one — both of which
 * are transient from this side, and neither of which is a reason to guess.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { GRAFT_LEDGER_LAYOUT_VERSION, assertLayoutSupported } from './layout.js'

/** The newest ledger epoch this reader understands. */
export const SUPPORTED_LEDGER_EPOCH = 2

export interface TransferredRecord {
  newSessionId: string
  at?: number
}

export interface LedgerSkip {
  file: string
  /** 0 when the file could not be parsed at all, 1 for a legacy payload. */
  epoch: number
  /**
   * `layout-unsupported` (P1-2) is decided BEFORE any file is opened: the directory's `.layout.json`
   * declares a layout this build does not speak, so nothing in it may be read. It is a skip rather
   * than a throw for the same reason `future-epoch` is: the writer may simply be newer than this
   * reader, and a retry after an upgrade is the correct outcome — but NOT a silent empty history.
   */
  reason: 'torn' | 'future-epoch' | 'layout-unsupported'
}

export interface LedgerSnapshot {
  /** Sessions that already handed off; their logs are finished and worth mining. */
  retired: string[]
  /** source → target map, for provenance and for skipping active sessions. */
  transferred: Record<string, TransferredRecord>
  /** v0.18: the epoch each file was written with (0 absent, 1 legacy, 2+ envelope). */
  epoch: { retired: number; transferred: number }
  /** v0.18: files that must not be trusted this round. */
  skipped: LedgerSkip[]
  /** True when at least one file was refused, i.e. a retry is owed. */
  deferred: boolean
  /**
   * P1-2: set when `.layout.json` refused the whole directory, carrying the `LAYOUT_UNSUPPORTED`
   * message verbatim so the log names both the layout found and the layout understood.
   */
  layoutRefusal?: string
}

interface LedgerRead {
  epoch: number
  payload: unknown
  defect?: 'torn' | 'future-epoch'
}

function readLedger(path: string): LedgerRead {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // Missing ledger is "no ledger", never an activation failure.
    return { epoch: 0, payload: undefined }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { epoch: 0, payload: undefined }
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'epoch' in (parsed as object)) {
    const record = parsed as Record<string, unknown>
    const epoch = Number(record.epoch)
    if (!Number.isFinite(epoch) || epoch <= 0) return { epoch: 0, payload: undefined, defect: 'torn' }
    if (epoch > SUPPORTED_LEDGER_EPOCH) return { epoch, payload: undefined, defect: 'future-epoch' }
    if (!('payload' in record) || record.payload === undefined || record.payload === null) {
      return { epoch, payload: undefined, defect: 'torn' }
    }
    return { epoch, payload: record.payload }
  }
  // A bare array/object is epoch 1: the shape written before the envelope existed.
  return { epoch: 1, payload: parsed }
}

export function readLedgers(dataDir: string): LedgerSnapshot {
  /**
   * P1-2: THE LAYOUT GATE RUNS BEFORE ANY FILE IS OPENED.
   *
   * A renamed ledger reads as `{ epoch: 0 }` — indistinguishable from "no ledger yet" — so a writer
   * that reorganised its directory used to make this side see an empty history and say nothing. The
   * directory's own `.layout.json` is the only thing that can tell the two apart, so it is checked
   * first, and a refusal produces NO entries rather than partial ones: half a ledger is worse than
   * none of it, because a harvest would attribute work to a history it only half saw.
   *
   * `assertLayoutSupported` THROWS `LayoutUnsupportedError` (code `LAYOUT_UNSUPPORTED`). That throw is
   * caught here and converted into this module's existing refuse-and-retry channel, deliberately: a
   * throw escaping onto the activation path would turn "the other plugin is a version ahead" into a
   * plugin that cannot load at all. The named error is what makes the condition greppable; the skip
   * is what makes the outcome survivable.
   */
  let layoutSkip: LedgerSkip | undefined
  try {
    assertLayoutSupported(dataDir, { version: GRAFT_LEDGER_LAYOUT_VERSION, producer: 'dsh-graft-slice' })
  } catch (error) {
    const detail = String((error as any)?.message ?? error)
    layoutSkip = { file: '.layout.json', epoch: 0, reason: 'layout-unsupported' }
    return {
      retired: [],
      transferred: {},
      epoch: { retired: 0, transferred: 0 },
      skipped: [layoutSkip],
      deferred: true,
      layoutRefusal: detail,
    }
  }

  const retiredPath = join(dataDir, '.retired.json')
  const transferredPath = join(dataDir, '.transferred.json')
  const retiredRead = readLedger(retiredPath)
  const transferredRead = readLedger(transferredPath)

  const skipped: LedgerSkip[] = []
  for (const [file, read] of [
    ['.retired.json', retiredRead],
    ['.transferred.json', transferredRead],
  ] as const) {
    if (read.defect !== undefined) skipped.push({ file, epoch: read.epoch, reason: read.defect })
  }

  const retired = Array.isArray(retiredRead.payload)
    ? retiredRead.payload.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : []
  const transferred: Record<string, TransferredRecord> = {}
  if (
    transferredRead.payload !== null &&
    typeof transferredRead.payload === 'object' &&
    !Array.isArray(transferredRead.payload)
  ) {
    for (const [id, value] of Object.entries(transferredRead.payload as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue
      const record = value as Record<string, unknown>
      if (typeof record.newSessionId !== 'string' || record.newSessionId.length === 0) continue
      transferred[id] = {
        newSessionId: record.newSessionId,
        ...(typeof record.at === 'number' ? { at: record.at } : {}),
      }
    }
  }
  return {
    retired: [...new Set(retired)],
    transferred,
    epoch: { retired: retiredRead.epoch, transferred: transferredRead.epoch },
    skipped,
    deferred: skipped.length > 0,
  }
}

/** One line per refused file, for the log and for a tool result. */
export function describeLedgerSkips(snapshot: LedgerSnapshot): string {
  if (snapshot.layoutRefusal !== undefined) return snapshot.layoutRefusal
  return snapshot.skipped
    .map((skip) => {
      if (skip.reason === 'future-epoch') {
        return `${skip.file}: written with epoch ${skip.epoch} but this reader understands up to ${SUPPORTED_LEDGER_EPOCH}; ignoring it and retrying next round`
      }
      return `${skip.file}: incomplete record (no payload); ignoring it and retrying next round`
    })
    .join('; ')
}
