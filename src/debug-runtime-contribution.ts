import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { DebugMcpServer, type DebugMcpLogger } from './debug-mcp-server.js'
import { DebugTools } from './debug-tools.js'
import type { DebugSessionManager } from './debug-session-manager.js'
import { debugRuntimePatch, injectDebugRuntimePatch, supportsDebugRuntime } from './debug-runtime-patch.js'
import { debugWorkspaceForPath } from './debug-workspace.js'
import type { RuntimeLaunchContext, RuntimeLaunchContributor, RuntimeLaunchPreparation } from './runtime-launch.js'

const DEBUG_TOKEN_ENV = 'DSH_VSCODE_DEBUG_TOKEN'

async function removeFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Starts the debug MCP bridge and overlays it into managed DSH launches. */
export class DebugRuntimeContribution implements RuntimeLaunchContributor {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sessions: DebugSessionManager,
    private readonly logger?: DebugMcpLogger,
  ) {}

  async prepare(launch: RuntimeLaunchContext): Promise<RuntimeLaunchPreparation | undefined> {
    const workspace = debugWorkspaceForPath(vscode.workspace.workspaceFolders ?? [], launch.workspacePath)
    if (workspace === undefined) throw new Error('The selected DeepSeek project is not an open VS Code workspace folder.')
    const enabled = vscode.workspace
      .getConfiguration('deepseekHarness', workspace.uri)
      .get<boolean>('autonomousDebugging', false)
    if (!enabled) return undefined

    const tools = new DebugTools(this.sessions, workspace)
    const bridge = new DebugMcpServer(tools, this.logger)
    let patchPath: string | undefined
    const dispose = async (): Promise<void> => {
      try {
        await bridge.dispose()
      } finally {
        try {
          if (patchPath !== undefined) await removeFile(patchPath)
        } finally {
          tools.dispose()
        }
      }
    }
    try {
      const endpoint = await bridge.start()
      const storage = this.context.storageUri ?? this.context.globalStorageUri
      await mkdir(storage.fsPath, { recursive: true })
      patchPath = path.join(storage.fsPath, `debug-${randomUUID()}.cordis.yml`)
      await writeFile(patchPath, debugRuntimePatch(endpoint), { encoding: 'utf8', mode: 0o600 })
      const finalPatchPath = patchPath
      return {
        environment: { [DEBUG_TOKEN_ENV]: bridge.authorizationToken },
        transformArguments: (args, version) => {
          if (!supportsDebugRuntime(version)) {
            throw new Error('Autonomous debugging requires DeepSeek Harness 0.1.0-rc.8 or later.')
          }
          return injectDebugRuntimePatch(args, finalPatchPath)
        },
        dispose,
      }
    } catch (error) {
      await dispose()
      throw error
    }
  }
}
