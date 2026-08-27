import * as path from 'node:path'

/** Normalize filesystem paths using the host filesystem's case semantics. */
export function comparableFilePath(filePath: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = path.normalize(filePath)
  return platform === 'darwin' || platform === 'win32' ? normalized.toLowerCase() : normalized
}
