import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { DebugMcpServer, type DebugMcpLogger } from './debug-mcp-server.js'
import { debugRuntimePatch, injectDebugRuntimePatch, supportsDebugRuntime } from './debug-runtime-patch.js'
import type { DebugToolHandler } from './debug-mcp-server.js'
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
    private readonly workspace: vscode.WorkspaceFolder,
    private readonly tools: DebugToolHandler,
    private readonly logger?: DebugMcpLogger,
  ) {}

  async prepare(_launch: RuntimeLaunchContext): Promise<RuntimeLaunchPreparation | undefined> {
    const enabled = vscode.workspace
      .getConfiguration('deepseekHarness', this.workspace.uri)
      .get<boolean>('autonomousDebugging', false)
    if (!enabled) return undefined

    const bridge = new DebugMcpServer(this.tools, this.logger)
    let patchPath: string | undefined
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
        dispose: async () => {
          await bridge.dispose()
          await removeFile(finalPatchPath)
        },
      }
    } catch (error) {
      await bridge.dispose()
      if (patchPath !== undefined) await removeFile(patchPath)
      throw error
    }
  }
}
