/**
 * Read the slicing plugin's ledgers.
 *
 * DECOUPLING CONTRACT: dsh-memory never imports dsh-graft-slice. The only thing
 * shared between the two plugins is a FILE FORMAT — `.retired.json` (array of
 * source session ids) and `.transferred.json` (id → { newSessionId, at }). This
 * module is the whole of that coupling, and it is read-only.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LedgerSnapshot {
  /** Sessions that already handed off; their logs are finished and worth mining. */
  retired: string[]
  /** source → target map, for provenance and for skipping active sessions. */
  transferred: Record<string, { newSessionId: string; at?: number }>
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // Missing or corrupt ledger is "no ledgers", never an activation failure.
    return undefined
  }
}

export function readLedgers(dataDir: string): LedgerSnapshot {
  const retiredRaw = readJson(join(dataDir, '.retired.json'))
  const transferredRaw = readJson(join(dataDir, '.transferred.json'))
  const retired = Array.isArray(retiredRaw)
    ? retiredRaw.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : []
  const transferred: LedgerSnapshot['transferred'] = {}
  if (transferredRaw !== null && typeof transferredRaw === 'object' && !Array.isArray(transferredRaw)) {
    for (const [id, value] of Object.entries(transferredRaw as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue
      const record = value as Record<string, unknown>
      if (typeof record.newSessionId !== 'string' || record.newSessionId.length === 0) continue
      transferred[id] = {
        newSessionId: record.newSessionId,
        ...(typeof record.at === 'number' ? { at: record.at } : {}),
      }
    }
  }
  return { retired: [...new Set(retired)], transferred }
}