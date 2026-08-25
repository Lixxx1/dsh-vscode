import * as path from 'node:path'
import type * as vscode from 'vscode'

export function debugWorkspaceForPath(
  folders: readonly vscode.WorkspaceFolder[],
  workspacePath: string,
): vscode.WorkspaceFolder | undefined {
  const expected = path.resolve(workspacePath)
  return folders.find(folder => path.resolve(folder.uri.fsPath) === expected)
}
