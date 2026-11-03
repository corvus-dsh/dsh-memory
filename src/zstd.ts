/**
 * Minimal DSH v4 session-log reader (independent implementation).
 *
 * The on-disk artifact is a CONCATENATION of zstd frames (one per checkpoint),
 * and Node's `zstdDecompressSync` decodes only the first frame. This walks the
 * frame headers itself so an offline harvest can read a finished log without the
 * host and without importing anything from the slicing plugin.
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const SKIPPABLE_MASK = 0xfffffff0
const SKIPPABLE_MAGIC = 0x184d2a50

function frameRanges(buffer: Buffer): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    const magic = buffer.readUInt32LE(offset)
    if ((magic & SKIPPABLE_MASK) === SKIPPABLE_MAGIC) {
      if (offset + 8 > buffer.length) break
      offset += 8 + buffer.readUInt32LE(offset + 4)
      continue
    }
    if (magic !== ZSTD_MAGIC) break
    const start = offset
    offset += 4
    if (offset >= buffer.length) break
    const descriptor = buffer[offset]
    offset += 1
    const contentSizeFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictionaryIdFlag = descriptor & 3
    if (singleSegment === 0) offset += 1
    offset += [0, 1, 2, 4][dictionaryIdFlag]
    offset += contentSizeFlag === 0 ? (singleSegment === 1 ? 1 : 0) : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8
    for (;;) {
      if (offset + 3 > buffer.length) throw new Error('truncated zstd block header')
      const header = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
      offset += 3
      const last = header & 1
      const type = (header >> 1) & 3
      const size = header >>> 3
      if (type === 0) offset += size
      else if (type === 1) offset += 1
      else if (type === 2) offset += size
      else throw new Error('reserved zstd block type')
      if (last === 1) break
    }
    if (checksum === 1) offset += 4
    ranges.push({ start, end: offset })
  }
  return ranges
}

export function decompressLog(buffer: Buffer): string {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) return buffer.toString('utf8')
  const ranges = frameRanges(buffer)
  if (ranges.length === 0) throw new Error('not a zstd frame stream')
  const parts: Buffer[] = []
  for (const range of ranges) parts.push(zstdDecompressSync(buffer.subarray(range.start, range.end)))
  return Buffer.concat(parts).toString('utf8')
}

export interface ParsedSession {
  session: Record<string, unknown>
  events: unknown[]
}

export function parseSessionLog(text: string): ParsedSession {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) throw new Error('empty session log')
  const header = JSON.parse(lines[0]) as Record<string, unknown>
  const events: unknown[] = []
  for (const line of lines.slice(1)) {
    try {
      events.push(JSON.parse(line))
    } catch {
      // A torn final frame (process killed mid-write) must not hide the rest.
      break
    }
  }
  return { session: header, events }
}

export function readSessionLogFile(path: string): ParsedSession {
  return parseSessionLog(decompressLog(readFileSync(path)))
}