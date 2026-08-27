import * as vscode from 'vscode'
import { comparableFilePath } from './file-path.js'
import { absoluteToolPaths } from './tool-write-guard.js'

export class DirtyFileGuard {
  conflicts(cwd: string, toolPaths: readonly string[]): vscode.TextDocument[] {
    const targets = new Set(absoluteToolPaths(cwd, toolPaths).map(filePath => comparableFilePath(filePath)))
    return vscode.workspace.textDocuments.filter(document =>
      document.isDirty
      && document.uri.scheme === 'file'
      && targets.has(comparableFilePath(document.uri.fsPath)),
    )
  }
}
