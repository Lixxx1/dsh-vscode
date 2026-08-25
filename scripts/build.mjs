import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

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
