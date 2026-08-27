import * as fs from 'node:fs'
import * as path from 'node:path'

/** Resolve an existing path to its filesystem identity without guessing case semantics. */
export function comparableFilePath(filePath: string): string {
  const normalized = path.normalize(filePath)
  try {
    return path.normalize(fs.realpathSync.native(normalized))
  } catch {
    // Missing paths have no filesystem identity yet. Preserve their spelling so
    // case-sensitive volumes never merge two distinct future files.
    return normalized
  }
}
