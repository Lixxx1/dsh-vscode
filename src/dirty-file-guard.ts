import * as path from 'node:path'
import * as vscode from 'vscode'
import { absoluteToolPaths } from './tool-write-guard.js'

function comparable(filePath: string): string {
  const normalized = path.normalize(filePath)
  return process.platform === 'darwin' || process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export class DirtyFileGuard {
  conflicts(cwd: string, toolPaths: readonly string[]): vscode.TextDocument[] {
    const targets = new Set(absoluteToolPaths(cwd, toolPaths).map(comparable))
    return vscode.workspace.textDocuments.filter(document =>
      document.isDirty
      && document.uri.scheme === 'file'
      && targets.has(comparable(document.uri.fsPath)),
    )
  }
}
