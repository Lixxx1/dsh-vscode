import { build } from 'esbuild'
import { copyFile, cp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true })

await build({
  entryPoints: { extension: 'src/extension.ts' },
  outdir: 'dist',
  entryNames: '[name]',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  minify: true,
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
})

await build({
  entryPoints: { markdown: 'src/markdown.mts' },
  outdir: 'dist/webview',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'dshMarkdown',
  target: 'chrome132',
  minify: true,
  sourcemap: true,
  legalComments: 'linked',
  logLevel: 'info',
})

await build({
  entryPoints: { scroll: 'src/conversation-scroll.mts' },
  outdir: 'dist/webview',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'dshConversationScroll',
  target: 'chrome132',
  minify: true,
  sourcemap: true,
  logLevel: 'info',
})

const require = createRequire(import.meta.url)
const katexRoot = dirname(require.resolve('katex/package.json'))
await mkdir('dist/webview/fonts', { recursive: true })
await copyFile(join(katexRoot, 'dist/katex.min.css'), 'dist/webview/katex.min.css')
await cp(join(katexRoot, 'dist/fonts'), 'dist/webview/fonts', { recursive: true, filter: source => !/\.(ttf|woff)$/.test(source) })
await copyFile(join(katexRoot, 'LICENSE'), 'dist/webview/katex.LICENSE.txt')
